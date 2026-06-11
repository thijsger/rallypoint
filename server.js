// PadelSmash server — houdt per pincode een wedstrijdstand bij + match history.
// Live state in geheugen, history naar history.json zodat 'm overleeft tussen
// requests. Op Render's free tier wordt de disk leeggegooid bij re-deploys —
// voor lange-termijn persistence: zet RENDER_DISK_PATH naar een persistent disk
// of switch naar een externe DB (Supabase, MongoDB Atlas etc.).
//
// Endpoints:
//   POST /match/:pin        -> horloge stuurt de stand (JSON body). saved=true → archiveer.
//   GET  /match/:pin        -> bord haalt de stand op
//   POST /match/:pin/reset  -> wis de stand
//   GET  /match/:pin/events -> SSE stream voor live updates
//   GET  /history/:pin      -> array van afgesloten wedstrijden
//   GET  /history/:pin/page -> serveer history.html
//   GET  /                  -> serveert het scorebord (public/index.html)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db.js');
const emailer = require('./email.js');

const PORT = process.env.PORT || 3000;
const TTL_MS = 1000 * 60 * 60 * 6; // live stand vervalt na 6 uur inactiviteit
const DATA_DIR = process.env.RENDER_DISK_PATH || __dirname;
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_PER_PIN = 100;

// --- TTS cache (ElevenLabs proxy) ---
const TTS_CACHE_DIR = path.join(DATA_DIR, 'tts');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Sarah, multilingual; user kan overriden via env-var
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
// Flash v2.5: respecteert language_code strict (multilingual_v2 negeerde 'm
// soms voor korte phrases), lagere latency, ~50% goedkoper. Override met
// ELEVENLABS_MODEL_ID env-var als je terug wil naar multilingual_v2.
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
const TTS_MAX_TEXT = 200;          // chars per phrase — voorkomt misbruik
const TTS_MAX_CACHE_MB = 200;      // hoeveel disk-ruimte de cache maximaal pakt
try { fs.mkdirSync(TTS_CACHE_DIR, { recursive: true }); } catch (e) {}

const BCRYPT_COST = 10;

const matches = {}; // pin -> { state, updated }
const clients = {}; // pin -> [res, ...]  (live SSE-verbindingen)
let history = {};   // pin -> [match, ...]  (afgesloten wedstrijden)
const seenSaveIds = {}; // pin -> Set(saveId)  voorkomt dubbele archivering bij retries

// --- BETA swing-log (privé diagnose) ---
const BETA_KEY = process.env.BETA_KEY || 'rp-swing-9f3a2c';
const BETA_LOG_FILE = path.join(DATA_DIR, 'beta-swing.jsonl');
const betaLogs = {}; // pin -> [batch, ...]  (in geheugen, file als backup)


try {
  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '{}');
  }
} catch (e) { history = {}; }

// Bouw seenSaveIds opnieuw op uit de gepersisteerde history — anders gaat
// dedup-cache verloren bij elke server-restart en retries archiveren dubbel.
for (const pin of Object.keys(history)) {
  if (!Array.isArray(history[pin])) continue;
  for (const m of history[pin]) {
    if (m && typeof m.saveId === 'string') {
      if (!seenSaveIds[pin]) seenSaveIds[pin] = new Set();
      seenSaveIds[pin].add(m.saveId);
    }
  }
}

// Startup-log: zien waar geschreven wordt zodat ephemeral-disk-issues
// meteen zichtbaar zijn in Render's deploy log.
console.log('[boot] DATA_DIR =', DATA_DIR);
console.log('[boot] HISTORY_FILE =', HISTORY_FILE);
console.log('[boot] history-pins loaded =', Object.keys(history).length);
console.log('[boot] ELEVENLABS_API_KEY present =', !!ELEVENLABS_API_KEY);
if (DATA_DIR === __dirname) {
  console.warn('[boot] WARNING: RENDER_DISK_PATH not set — history overleeft geen redeploy. Mount een Render Disk en zet de env-var.');
}

// --- Auth helpers ---
const COOKIE_NAME = 'rps';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(/;\s*/).forEach(p => {
    const idx = p.indexOf('=');
    if (idx <= 0) return;
    out[p.slice(0, idx).trim()] = decodeURIComponent(p.slice(idx + 1));
  });
  return out;
}

function setSessionCookie(res, token, maxAgeSec) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    // Expliciete Expires naast Max-Age — sommige (oudere/iOS) browsers
    // bewaren een cookie alleen persistent met een Expires-datum.
    `Expires=${new Date(Date.now() + maxAgeSec * 1000).toUTCString()}`,
  ];
  // Secure in productie (https). Render serveert https, dus altijd aan.
  if (process.env.NODE_ENV !== 'development') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
}

function getUserFromReq(req) {
  const cookies = parseCookies(req);
  return db.getSessionUser(cookies[COOKIE_NAME]);
}

function readJsonBody(req, maxBytes = 50000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
}
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }

// Aggregeert match-stats over alle PINs die aan deze user gekoppeld zijn.
// Verzamelt totaal aantal, finished, wins, duration, points en sport-counts.
function statsForUser(userId) {
  const pins = db.getPinsForUser(userId).map(p => p.pin);
  let total = 0, finished = 0, wins = 0, totalDuration = 0, totalPoints = 0;
  let longestMatchPts = 0;
  const sportCounts = {};
  for (const pin of pins) {
    const list = history[pin] || [];
    for (const m of list) {
      total++;
      totalDuration += Number(m.durationMin) || 0;
      totalPoints += Number(m.totalPoints) || 0;
      if ((Number(m.totalPoints) || 0) > longestMatchPts) longestMatchPts = Number(m.totalPoints) || 0;
      const sport = typeof m.sport === 'number' ? m.sport : 0;
      sportCounts[sport] = (sportCounts[sport] || 0) + 1;
      if (m.over && !m.manuallySaved) {
        finished++;
        if (m.winner === 0) wins++;
      }
    }
  }
  // Favorite sport: sport met de hoogste count
  let favoriteSport = null, favoriteCount = 0;
  for (const k of Object.keys(sportCounts)) {
    if (sportCounts[k] > favoriteCount) { favoriteCount = sportCounts[k]; favoriteSport = Number(k); }
  }
  return {
    total_matches: total,
    finished_matches: finished,
    wins,
    win_rate: finished > 0 ? Math.round((wins / finished) * 100) : null,
    total_duration_min: totalDuration,
    total_points: totalPoints,
    longest_match_pts: longestMatchPts,
    most_played_sport: favoriteSport,
    pin_count: pins.length,
  };
}

let writeQueued = false;
function persistHistory() {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    // Atomic write: tmp + rename. Voorkomt corrupte/halve history.json als
    // het proces midden in een write gekild wordt.
    const tmp = HISTORY_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(history));
      fs.renameSync(tmp, HISTORY_FILE);
    } catch (e) {
      console.error('[history] write failed:', e && e.message);
    }
  }, 100);
}

function broadcast(pin, state) {
  const list = clients[pin];
  if (!list || !list.length) { return; }
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of list) { try { res.write(data); } catch (e) {} }
}

// Normaliseert korte sleutels (geheugenbesparend formaat van FR55) naar lange sleutels.
// Accepteert zowel oud formaat (points/games/sets als arrays) als nieuw (p0,p1,g0,g1,...).
function normalizeState(s) {
  if (!s || typeof s !== 'object') return s;
  // Alleen converteren als we de korte variant zien
  if ('p0' in s || 'g0' in s || 's0' in s) {
    const n = {
      points:  [s.p0 || 0, s.p1 || 0],
      games:   [s.g0 || 0, s.g1 || 0],
      sets:    [s.s0 || 0, s.s1 || 0],
      over:    !!s.over, winner: s.win !== undefined ? s.win : -1,
      tiebreak: !!s.tb, serveTeam: s.srv || 0, serveSide: s.side || 0,
      servePlayer: s.plr || 0, serveNo: s.sno || 0,
      switchSides: !!s.sw, fmt: s.fmt || 1, sport: s.spt || 0,
      golden: !!s.gld, rally: !!s.rl,
      teamUs: s.tu || 'Us', teamThem: s.tt || 'Them',
      lang: s.lg || 'en', setupCode: s.sc || '', saved: !!s.saved, saveId: s.sid || '',
      // Stats (alleen bij saved=true aanwezig)
      totalPoints: s.tp || 0, durationMin: s.dm || 0,
      tiebreaks: s.tb2 || 0, deuceGames: s.dg || 0, sideSwitches: s.ss || 0,
      ptsPerMin: s.ppm || 0, avgPtsGame: s.apg || 0,
      pointsByTeam: [s.ptb0 || 0, s.ptb1 || 0],
      longestStreak: [s.ls0 || 0, s.ls1 || 0],
      history: Array.isArray(s.log) ? s.log : [],
      setHistory: Array.isArray(s.sh) ? s.sh : [],
      setStats: Array.isArray(s.sst) ? s.sst : [],
    };
    return n;
  }
  return s;
}

function freshMatch() {
  return { points:[0,0], games:[0,0], sets:[0,0], over:false, winner:-1, history:[], golden:false, fmt:1, lang:'en' };
}

// Bouw een compacte history-entry uit de live state op het moment van saven.
// Handmatige save (state.saved=true) telt als "match ended" in de history,
// ook als het scorebord nog midden in een set zit.
function snapshotForHistory(state) {
  const setHistory = Array.isArray(state.setHistory) ? state.setHistory : [];
  const games = Array.isArray(state.games) ? state.games : [0, 0];
  const points = Array.isArray(state.points) ? state.points : [0, 0];
  const hasUnfinishedSet = (games[0] > 0 || games[1] > 0 || points[0] > 0 || points[1] > 0);
  const manuallySaved = !!state.saved;
  return {
    savedAt: Date.now(),
    saveId: typeof state.saveId === 'string' ? state.saveId : null,
    fp: matchFingerprint(state),
    sport: typeof state.sport === 'number' ? state.sport : 0,
    fmt: typeof state.fmt === 'number' ? state.fmt : 1,
    golden: !!state.golden,
    rally: !!state.rally,
    sets: Array.isArray(state.sets) ? state.sets : [0, 0],
    games: games,
    points: points,
    setHistory: setHistory,
    hasUnfinishedSet: hasUnfinishedSet,
    inProgress: hasUnfinishedSet && !manuallySaved && !state.over,
    over: !!state.over || manuallySaved,
    manuallySaved: manuallySaved,
    winner: typeof state.winner === 'number' ? state.winner : -1,
    totalPoints: Number(state.totalPoints) || 0,
    longestStreak: Array.isArray(state.longestStreak) ? state.longestStreak : [0, 0],
    durationMin: Number(state.durationMin) || 0,
    tiebreaks: Number(state.tiebreaks) || 0,
    deuceGames: Number(state.deuceGames) || 0,
    sideSwitches: Number(state.sideSwitches) || 0,
    ptsPerMin: Number(state.ptsPerMin) || 0,
    avgPtsGame: Number(state.avgPtsGame) || 0,
    pointsByTeam: Array.isArray(state.pointsByTeam) ? state.pointsByTeam : [0, 0],
    setStats: Array.isArray(state.setStats) ? state.setStats : [],
    teamUs: typeof state.teamUs === 'string' ? state.teamUs : 'Us',
    teamThem: typeof state.teamThem === 'string' ? state.teamThem : 'Them',
    lang: typeof state.lang === 'string' ? state.lang : 'en',
    // pointLog: array van 0/1 per scorende team (volgorde = chronologisch).
    // Gebruikt voor match-flow chart in /history.
    pointLog: Array.isArray(state.history) ? state.history.map(n => Number(n) === 1 ? 1 : 0) : [],
  };
}

// Stabiele vingerafdruk van een match: alleen velden die niet wijzigen na de
// laatste rally. Twee uploads van dezelfde wedstrijd (bv. door een server-
// herstart die seenSaveIds wist en de watch retry) krijgen dezelfde fingerprint
// → dedup voorkomt dubbel-in-history.
function matchFingerprint(state) {
  return [
    typeof state.sport === 'number' ? state.sport : 0,
    typeof state.winner === 'number' ? state.winner : -1,
    JSON.stringify(Array.isArray(state.sets) ? state.sets : [0, 0]),
    JSON.stringify(Array.isArray(state.setHistory) ? state.setHistory : []),
    Number(state.totalPoints) || 0,
  ].join('|');
}

function archiveMatch(pin, state) {
  if (!history[pin]) { history[pin] = []; }
  const snap = snapshotForHistory(state);

  // Dedup: zelfde saveId of zelfde fingerprint binnen de laatste paar entries
  // = waarschijnlijk dezelfde wedstrijd die opnieuw binnenkomt (retry of
  // server-restart). Sla over.
  const recent = history[pin].slice(-5);
  const dupe = recent.find(m =>
    (snap.saveId != null && m.saveId === snap.saveId) ||
    (snap.fp && m.fp === snap.fp)
  );
  if (dupe) { return; }

  history[pin].push(snap);
  if (history[pin].length > MAX_PER_PIN) {
    history[pin] = history[pin].slice(-MAX_PER_PIN);
  }
  persistHistory();
}

// Ruim oude live-wedstrijden periodiek op
setInterval(() => {
  const now = Date.now();
  for (const pin of Object.keys(matches)) {
    if (now - matches[pin].updated > TTL_MS) { delete matches[pin]; }
  }
}, 1000 * 60 * 10);

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function validPin(pin) { return /^\d{4}$/.test(pin); }

// --- TTS: proxy naar ElevenLabs met disk-cache ---
// Eerste request voor een phrase = API-call + cache schrijven. Daarna serveert
// de cache het MP3 instant en gratis. Onder ~200MB blijft de cache vanzelf zo
// klein dat we niet hoeven op te ruimen; daarboven gooien we LRU weg.
async function handleTts(req, res, lang, text, voiceOverride) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (!ELEVENLABS_API_KEY) {
    res.writeHead(503, Object.assign({ 'Content-Type': 'text/plain' }, cors));
    return res.end('TTS not configured');
  }
  if (!/^[a-z]{2}$/i.test(lang)) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain' }, cors));
    return res.end('Bad lang');
  }
  if (!text || text.length > TTS_MAX_TEXT) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain' }, cors));
    return res.end('Bad text');
  }

  // Voice override uit query — gebruikers picken uit een vaste lijst in de UI.
  // Beperk tot ElevenLabs voice-ID formaat (~20 alfanumeriek) zodat misbruik
  // moeilijker wordt; ongeldige strings vallen terug op de default.
  const voiceId = (typeof voiceOverride === 'string' && /^[A-Za-z0-9]{15,30}$/.test(voiceOverride))
    ? voiceOverride : ELEVENLABS_VOICE_ID;

  // cv2 = cache-versie; bump bij wijziging van API-payload (bv. language_code
  // toegevoegd) zodat oude mis-getalde audio niet meer wordt teruggegeven.
  const cacheKey = `cv2|${lang}|${text}|${voiceId}|${ELEVENLABS_MODEL_ID}`;
  const hash = crypto.createHash('sha256').update(cacheKey).digest('hex');
  const cachePath = path.join(TTS_CACHE_DIR, `${hash}.mp3`);

  try {
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath);
      // Markeer als recent gebruikt voor LRU-prune
      try { const now = new Date(); fs.utimesSync(cachePath, now, now); } catch (_) {}
      res.writeHead(200, Object.assign({
        'Content-Type': 'audio/mpeg',
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Cache': 'HIT'
      }, cors));
      return res.end(data);
    }
  } catch (e) {}

  // Cache-miss: ophalen bij ElevenLabs en wegschrijven
  try {
    const apiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    const apiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID,
        language_code: lang.toLowerCase(),    // dwing taal af; v2 zou anders bij korte phrases gokken
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.4, use_speaker_boost: true }
      })
    });
    if (!apiRes.ok) {
      const errBody = await apiRes.text().catch(() => '');
      console.error('[tts] ElevenLabs', apiRes.status, errBody.slice(0, 200));
      const code = (apiRes.status === 401 || apiRes.status === 403) ? 502
                 : (apiRes.status === 429) ? 429
                 : 502;
      res.writeHead(code, Object.assign({ 'Content-Type': 'text/plain' }, cors));
      return res.end('TTS upstream error');
    }
    const buf = Buffer.from(await apiRes.arrayBuffer());
    try { fs.writeFileSync(cachePath, buf); } catch (e) {}
    pruneTtsCacheIfNeeded();
    res.writeHead(200, Object.assign({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Cache': 'MISS'
    }, cors));
    return res.end(buf);
  } catch (e) {
    console.error('[tts] handler error', e && e.message);
    res.writeHead(502, Object.assign({ 'Content-Type': 'text/plain' }, cors));
    return res.end('TTS failed');
  }
}

let ttsPruneScheduled = false;
function pruneTtsCacheIfNeeded() {
  if (ttsPruneScheduled) return;
  ttsPruneScheduled = true;
  setImmediate(() => {
    ttsPruneScheduled = false;
    try {
      const limit = TTS_MAX_CACHE_MB * 1024 * 1024;
      const files = fs.readdirSync(TTS_CACHE_DIR)
        .filter(f => f.endsWith('.mp3'))
        .map(f => { const p = path.join(TTS_CACHE_DIR, f); return { p, stat: fs.statSync(p) }; });
      const total = files.reduce((s, f) => s + f.stat.size, 0);
      if (total <= limit) return;
      files.sort((a, b) => a.stat.atimeMs - b.stat.atimeMs);   // oudste atime eerst
      let cur = total;
      for (const f of files) {
        if (cur <= limit) break;
        try { fs.unlinkSync(f.p); cur -= f.stat.size; } catch (_) {}
      }
    } catch (e) {}
  });
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // --- TTS proxy: /tts/:lang/:text?voice=<id>&pin=<pin> — ElevenLabs + cache
  // Gated: client moet PIN meegeven die access heeft (trial/active).
  if (parts[0] === 'tts' && req.method === 'GET' && parts.length >= 3) {
    const lang = parts[1];
    const text = decodeURIComponent(parts.slice(2).join('/'));
    const voice = url.searchParams.get('voice') || '';
    const pin = url.searchParams.get('pin') || '';
    if (!validPin(pin)) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      return res.end('Bad pin');
    }
    handleTts(req, res, lang, text, voice);
    return;
  }

  // --- Auth API ---
  if (parts[0] === 'api' && parts[1] === 'auth') {
    if (parts[2] === 'signup' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const email = String(body.email || '').toLowerCase().trim();
        const password = String(body.password || '');
        if (!validEmail(email)) return sendJSON(res, 400, { error: 'bad_email' });
        if (!validPassword(password)) return sendJSON(res, 400, { error: 'bad_password', msg: 'min 8 tekens' });
        if (db.getUserByEmail(email)) return sendJSON(res, 409, { error: 'email_taken' });
        const hash = bcrypt.hashSync(password, BCRYPT_COST);
        const { id, verifyToken } = db.createUser(email, hash, db.normLang(body.lang));
        // Stuur verify-mail (best-effort, niet blokkerend op fout)
        emailer.sendVerifyEmail(email, verifyToken).catch(e => console.error('[signup] verify-mail fail:', e && e.message));
        // Claim orphan licenses + PINs voor deze email (paid users die migreren)
        const claim = db.claimOrphansForUser(id, email);
        // Meteen ingelogd → sessie + cookie
        const sess = db.createSession(id, 30);
        setSessionCookie(res, sess.token, 30 * 24 * 60 * 60);
        return sendJSON(res, 200, { ok: true, user_id: id, email, email_verified: false, claimed_licenses: claim.claimed });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'login' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const email = String(body.email || '').toLowerCase().trim();
        const password = String(body.password || '');
        if (!validEmail(email) || !password) return sendJSON(res, 400, { error: 'bad_credentials' });
        const user = db.getUserByEmail(email);
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
          return sendJSON(res, 401, { error: 'bad_credentials' });
        }
        const sess = db.createSession(user.id, 30);
        setSessionCookie(res, sess.token, 30 * 24 * 60 * 60);
        return sendJSON(res, 200, { ok: true, user_id: user.id, email: user.email, email_verified: !!user.email_verified });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'logout' && req.method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies[COOKIE_NAME]) db.deleteSession(cookies[COOKIE_NAME]);
      clearSessionCookie(res);
      return sendJSON(res, 200, { ok: true });
    }
    if (parts[2] === 'me' && req.method === 'GET') {
      const user = getUserFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'not_authenticated' });
      const pins = db.getPinsForUser(user.id);
      const lic = db.getLicense(user.id);
      return sendJSON(res, 200, {
        user_id: user.id,
        email: user.email,
        email_verified: !!user.email_verified,
        lang: user.lang || null,
        pins: pins.map(p => p.pin),
        license: lic ? {
          status: lic.status, plan: lic.plan, expires_at: lic.expires_at,
          trial_used: !!lic.trial_used_at,
        } : null,
      });
    }
    if (parts[2] === 'forgot' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const email = String(body.email || '').toLowerCase().trim();
        if (!validEmail(email)) return sendJSON(res, 400, { error: 'bad_email' });
        const user = db.getUserByEmail(email);
        // Antwoord ALTIJD success — voorkomt email-enumeration via timing.
        if (user) {
          const token = db.setResetToken(user.id);
          emailer.sendPasswordResetEmail(email, token).catch(e => console.error('[forgot] mail fail:', e && e.message));
        }
        return sendJSON(res, 200, { ok: true });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'reset' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const token = String(body.token || '');
        const password = String(body.password || '');
        if (!token || !validPassword(password)) return sendJSON(res, 400, { error: 'bad_input' });
        const user = db.getUserByResetToken(token);
        if (!user) return sendJSON(res, 400, { error: 'invalid_token' });
        const hash = bcrypt.hashSync(password, BCRYPT_COST);
        db.updatePassword(user.id, hash);
        return sendJSON(res, 200, { ok: true });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'verify' && parts[3] && req.method === 'GET') {
      // Token verify via GET → 302 redirect naar /account?verified=1
      const token = parts[3];
      const user = db.getUserByVerifyToken(token);
      if (user) db.markEmailVerified(user.id);
      res.writeHead(302, { 'Location': user ? '/account?verified=1' : '/account?verified=0' });
      return res.end();
    }
    if (parts[2] === 'change-password' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const user = getUserFromReq(req);
        if (!user) return sendJSON(res, 401, { error: 'not_authenticated' });
        const cur = String(body.current_password || '');
        const next = String(body.new_password || '');
        if (!validPassword(next)) return sendJSON(res, 400, { error: 'bad_password' });
        if (!bcrypt.compareSync(cur, user.password_hash)) return sendJSON(res, 401, { error: 'bad_current' });
        const hash = bcrypt.hashSync(next, BCRYPT_COST);
        db.updatePassword(user.id, hash);
        // Maak meteen een nieuwe sessie aan (updatePassword wist alle sessies)
        const sess = db.createSession(user.id, 30);
        setSessionCookie(res, sess.token, 30 * 24 * 60 * 60);
        return sendJSON(res, 200, { ok: true });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'change-email' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const user = getUserFromReq(req);
        if (!user) return sendJSON(res, 401, { error: 'not_authenticated' });
        const cur = String(body.current_password || '');
        const newEmail = String(body.new_email || '').toLowerCase().trim();
        if (!validEmail(newEmail)) return sendJSON(res, 400, { error: 'bad_email' });
        if (!bcrypt.compareSync(cur, user.password_hash)) return sendJSON(res, 401, { error: 'bad_current' });
        if (db.getUserByEmail(newEmail) && newEmail !== user.email) return sendJSON(res, 409, { error: 'email_taken' });
        // Direct updaten + verify-mail naar nieuw adres sturen
        try {
          db.changeEmail(user.id, newEmail);
        } catch (e) { return sendJSON(res, 500, { error: 'change_failed' }); }
        const refreshed = db.getUserById(user.id);
        emailer.sendVerifyEmail(newEmail, refreshed.verify_token).catch(e => console.error('[change-email] mail fail:', e && e.message));
        return sendJSON(res, 200, { ok: true });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'delete-account' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const user = getUserFromReq(req);
        if (!user) return sendJSON(res, 401, { error: 'not_authenticated' });
        const cur = String(body.current_password || '');
        if (!bcrypt.compareSync(cur, user.password_hash)) return sendJSON(res, 401, { error: 'bad_current' });
        db.deleteUser(user.id);   // cascades naar sessions, account_pins, licenses
        clearSessionCookie(res);
        return sendJSON(res, 200, { ok: true });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    return sendJSON(res, 404, { error: 'Not found' });
  }

  // --- Account API (alle endpoints vereisen authenticated user) ---
  if (parts[0] === 'api' && parts[1] === 'account') {
    // Publieke endpoints (geen login nodig) — vóór de auth-gate afhandelen.
    if (parts[2] === 'spectator' && parts[3] === 'active' && req.method === 'GET') {
      // Publieke lijst van actieve matches.
      // Alleen pins waarvan eigenaar is_public=1 heeft staan + match is recent.
      const RECENT_MS = 10 * 60 * 1000;
      const now = Date.now();
      const result = [];
      for (const pin of Object.keys(matches)) {
        const m = matches[pin];
        if (!m || (now - m.updated) > RECENT_MS) continue;
        if (m.state && m.state.over) continue;   // alleen lopende
        const owner = db.getPinOwner(pin);
        if (!owner) continue;
        const u = db.getUserById(owner.user_id);
        if (!u || !u.is_public) continue;
        result.push({
          pin,
          owner_name: u.display_name || u.email.split('@')[0],
          owner_initial: (u.display_name || u.email).charAt(0).toUpperCase(),
          sport: (m.state && m.state.sport) || 0,
          sets: (m.state && m.state.sets) || [0,0],
          games: (m.state && m.state.games) || [0,0],
          updated_at: m.updated,
        });
      }
      result.sort((a, b) => b.updated_at - a.updated_at);
      return sendJSON(res, 200, result);
    }

    const user = getUserFromReq(req);
    if (!user) return sendJSON(res, 401, { error: 'not_authenticated' });

    if (parts[2] === 'couple-pin' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const pin = String(body.pin || '');
        const code = String(body.code || '').toLowerCase().trim();
        if (!validPin(pin)) return sendJSON(res, 400, { error: 'bad_pin' });
        if (!/^[0-9a-f]{6}$/.test(code)) return sendJSON(res, 400, { error: 'bad_code' });

        // Server moet de setup-code van deze PIN kennen — die wordt door de
        // watch meegestuurd in /match POST. Geen code = watch nog niet
        // geüpload sinds server-start → user moet eerst de watch-app openen.
        const m = matches[pin];
        if (!m || !m.setupCode) {
          return sendJSON(res, 412, { error: 'watch_not_active' });
        }
        if (m.setupCode !== code) {
          return sendJSON(res, 401, { error: 'bad_code' });
        }

        const result = db.pairPin(pin, user.id);
        if (!result.ok) return sendJSON(res, 409, { error: result.error || 'cannot_pair' });
        return sendJSON(res, 200, { ok: true, pin, already_owned: !!result.alreadyOwned });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'pins' && !parts[3] && req.method === 'GET') {
      return sendJSON(res, 200, db.getPinsForUser(user.id).map(p => p.pin));
    }
    if (parts[2] === 'active-pin' && req.method === 'GET') {
      // Geeft de PIN van deze user waarvan de watch het meest recent heeft
      // geüpload (binnen het laatste uur). Voor auto-connect op scoreboard.
      const pins = db.getPinsForUser(user.id).map(p => p.pin);
      const now = Date.now();
      const RECENT_MS = 60 * 60 * 1000;
      let best = null;
      for (const pin of pins) {
        const m = matches[pin];
        if (!m || (now - m.updated) > RECENT_MS) continue;
        if (!best || m.updated > best.updated) {
          best = { pin, updated: m.updated, over: !!(m.state && m.state.over) };
        }
      }
      return sendJSON(res, 200, { pin: best ? best.pin : null, info: best });
    }
    if (parts[2] === 'pins' && parts[3] && req.method === 'DELETE') {
      const pin = parts[3];
      if (!validPin(pin)) return sendJSON(res, 400, { error: 'bad_pin' });
      db.unpairPin(pin, user.id);
      return sendJSON(res, 200, { ok: true });
    }
    if (parts[2] === 'profile' && req.method === 'GET') {
      const pins = db.getPinsForUser(user.id).map(p => p.pin);
      return sendJSON(res, 200, {
        user_id: user.id,
        email: user.email,
        email_verified: !!user.email_verified,
        display_name: user.display_name || null,
        avatar_url: user.avatar_url || null,
        favorite_sport: user.favorite_sport == null ? null : Number(user.favorite_sport),
        is_public: !!user.is_public,
        lang: user.lang || null,
        created_at: user.created_at,
        pins,
        stats: statsForUser(user.id),
      });
    }
    // Taalvoorkeur wijzigen (los endpoint zodat de taalkiezer geen heel
    // profiel hoeft mee te sturen)
    if (parts[2] === 'lang' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        db.updateLang(user.id, db.normLang(body.lang));
        return sendJSON(res, 200, { ok: true, lang: db.normLang(body.lang) });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'profile' && req.method === 'PATCH') {
      return readJsonBody(req).then(body => {
        const fields = {};
        if (body.display_name !== undefined) {
          const dn = String(body.display_name || '').trim().slice(0, 60);
          fields.display_name = dn || null;
        }
        if (body.avatar_url !== undefined) {
          const av = String(body.avatar_url || '').trim().slice(0, 500);
          if (av && !/^https?:\/\//i.test(av)) return sendJSON(res, 400, { error: 'bad_avatar' });
          fields.avatar_url = av || null;
        }
        if (body.favorite_sport !== undefined) {
          const fs = body.favorite_sport == null ? null : Number(body.favorite_sport);
          if (fs != null && (!Number.isInteger(fs) || fs < 0 || fs > 5)) {
            return sendJSON(res, 400, { error: 'bad_sport' });
          }
          fields.favorite_sport = fs;
        }
        if (body.is_public !== undefined) {
          fields.is_public = !!body.is_public;
        }
        db.updateProfile(user.id, fields);
        return sendJSON(res, 200, { ok: true });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    return sendJSON(res, 404, { error: 'Not found' });
  }

  // --- Legal pages (/about, /privacy, /terms)
  if (parts[0] && !parts[1] && req.method === 'GET') {
    const legal = { 'about': 'about.html', 'privacy': 'privacy.html', 'terms': 'terms.html' };
    if (legal[parts[0]]) {
      return fs.readFile(path.join(__dirname, 'public', 'legal', legal[parts[0]]), (err, data) => {
        if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    }
  }

  // --- /couple — QR/manual coupling landing
  if (parts[0] === 'couple' && !parts[1] && req.method === 'GET') {
    return fs.readFile(path.join(__dirname, 'public', 'couple.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  // --- Spectator: list page + viewer
  if (parts[0] === 'spectator' && !parts[1] && req.method === 'GET') {
    return fs.readFile(path.join(__dirname, 'public', 'spectator.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }
  if (parts[0] === 'spectate' && parts[1] && req.method === 'GET') {
    const pin = parts[1];
    if (!validPin(pin)) { res.writeHead(404); return res.end('Pin niet geldig'); }
    res.writeHead(302, { 'Location': `/?pin=${pin}` });
    return res.end();
  }

  // Publieke "Coming soon"-pagina voor de AI-coach (zonder pin/sleutel).
  // De echte coach zit op /beta/coach/:pin?beta=<sleutel>.
  if (parts[0] === 'coach' && !parts[1] && req.method === 'GET') {
    return fs.readFile(path.join(__dirname, 'public', 'beta', 'coach.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('pagina ontbreekt'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  // --- BETA-pagina's: HTML wordt publiek geserveerd (toont zelf "Coming soon"
  // zonder geldige sleutel); de DATA hieronder blijft achter de sleutel. ---
  if (parts[0] === 'beta' && (parts[1] === 'coach' || parts[1] === 'stats' || parts[1] === 'view') && parts[2] && req.method === 'GET') {
    const file = parts[1] === 'stats' ? 'stats.html' : parts[1] === 'coach' ? 'coach.html' : 'view.html';
    return fs.readFile(path.join(__dirname, 'public', 'beta', file), (err, data) => {
      if (err) { res.writeHead(404); return res.end('pagina ontbreekt'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  // --- BETA swing-log (privé, achter ?beta=<sleutel>) ---
  // POST /beta/log/:pin  -> watch stuurt batch
  // GET  /beta/log/:pin  -> JSON van alle batches (voor analyse)
  if (parts[0] === 'beta' && parts[1] === 'log' && parts[2]) {
    if (url.searchParams.get('beta') !== BETA_KEY) { res.writeHead(403); return res.end('nope'); }
    const pin = parts[2];
    if (!validPin(pin)) { res.writeHead(404); return res.end('pin'); }

    if (parts[1] === 'log' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const batch = JSON.parse(body || '{}');
          batch.recv = Date.now();
          if (!betaLogs[pin]) { betaLogs[pin] = []; }
          betaLogs[pin].push(batch);
          if (betaLogs[pin].length > 5000) { betaLogs[pin].shift(); }
          try { fs.appendFileSync(BETA_LOG_FILE, JSON.stringify({ pin, ...batch }) + '\n'); } catch (e) {}
          sendJSON(res, 200, { ok: true });
        } catch (e) { sendJSON(res, 400, { error: 'bad json' }); }
      });
      return;
    }
    if (parts[1] === 'log' && req.method === 'GET') {
      return sendJSON(res, 200, { pin, batches: betaLogs[pin] || [] });
    }
    if (parts[1] === 'log' && req.method === 'DELETE') {
      betaLogs[pin] = [];
      return sendJSON(res, 200, { ok: true });
    }
    res.writeHead(405); return res.end('method');
  }

  // --- Account pages (/account, /account/login, /account/signup, etc.)
  // Verify-link en reset/:token zijn speciale paths; rest is static HTML serven.
  // CSS en andere assets vallen door naar de static handler onderaan.
  if (parts[0] === 'account' && req.method === 'GET') {
    // /account/verify/:token → mark verified + redirect terug naar dashboard
    if (parts[1] === 'verify' && parts[2]) {
      const token = parts[2];
      const user = db.getUserByVerifyToken(token);
      if (user) { db.markEmailVerified(user.id); }
      res.writeHead(302, { 'Location': user ? '/account?verified=1' : '/account?verified=0' });
      return res.end();
    }
    // /account/reset/:token → serve reset.html (JS leest token uit URL)
    if (parts[1] === 'reset' && parts[2]) {
      return fs.readFile(path.join(__dirname, 'public', 'account', 'reset.html'), (err, data) => {
        if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    }
    // Bekende page-namen → corresponderende HTML
    const pages = {
      '': 'index.html', 'login': 'login.html', 'signup': 'signup.html',
      'forgot': 'forgot.html', 'reset': 'reset.html', 'profile': 'profile.html',
      'onboarding': 'onboarding.html', 'settings': 'settings.html',
    };
    const pageKey = parts[1] || '';
    if (pages[pageKey] !== undefined && !parts[2]) {
      return fs.readFile(path.join(__dirname, 'public', 'account', pages[pageKey]), (err, data) => {
        if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    }
    // Onbekend account-path: laat door naar static (bv. /account/style.css)
  }

  // --- /history (zonder PIN) — serveer de pagina; JS toont een "vul PIN in" hint
  if (parts[0] === 'history' && !parts[1] && req.method === 'GET') {
    const filePath = path.join(__dirname, 'public', 'history.html');
    return fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }

  // --- History API + page ---
  if (parts[0] === 'history' && parts[1]) {
    const pin = parts[1];
    if (!validPin(pin)) { return sendJSON(res, 400, { error: 'Pincode moet 4 cijfers zijn.' }); }

    // Browser-bezoek naar /history/1234 → serveer de HTML-pagina
    if (req.method === 'GET' && (parts[2] === 'page' || (req.headers.accept || '').includes('text/html'))) {
      const filePath = path.join(__dirname, 'public', 'history.html');
      return fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
    }

    if (req.method === 'GET') {
      const list = (history[pin] || []).slice().reverse(); // nieuwste eerst
      return sendJSON(res, 200, list);
    }
    if (req.method === 'DELETE') {
      delete history[pin];
      delete seenSaveIds[pin];
      persistHistory();
      return sendJSON(res, 200, { ok: true });
    }
  }

  // --- Match API (publiek — watch upload + live view zijn gratis) ---
  if (parts[0] === 'match' && parts[1]) {
    const pin = parts[1];
    if (!validPin(pin)) { return sendJSON(res, 400, { error: 'Pincode moet 4 cijfers zijn.' }); }

    // Live updates (SSE)
    if (parts[2] === 'events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 3000\n\n');
      const m = matches[pin];
      res.write(`data: ${JSON.stringify(m ? m.state : freshMatch())}\n\n`);
      if (!clients[pin]) { clients[pin] = []; }
      clients[pin].push(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => {
        clearInterval(hb);
        clients[pin] = (clients[pin] || []).filter(r => r !== res);
      });
      return;
    }

    // Reset — match is voorbij, volgende auto-archive is weer mogelijk
    if (parts[2] === 'reset' && req.method === 'POST') {
      const state = freshMatch();
      matches[pin] = { state, updated: Date.now(), wasOver: false, autoArchived: false };
      broadcast(pin, { ...state, discarded: true });
      return sendJSON(res, 200, { ok: true });
    }

    // Horloge stuurt stand
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const state = normalizeState(JSON.parse(body || '{}'));
          const prev = matches[pin] || { wasOver: false, autoArchived: false };

          // Nieuwe match begonnen (over flip true→false): auto-archive flag resetten
          let autoArchived = prev.autoArchived;
          if (prev.wasOver && !state.over) { autoArchived = false; }

          // Setup-code (immutable na 1e set) — voor account-coupling.
          // Eenmaal gezet niet meer overschreven; voorkomt dat een aanvaller
          // een gespoofte upload met fake code de coupling overneemt.
          const incomingCode = (typeof state.setupCode === 'string' && /^[0-9a-f]{6}$/i.test(state.setupCode))
            ? state.setupCode.toLowerCase() : null;
          const keepCode = prev.setupCode || incomingCode || null;

          matches[pin] = {
            state,
            updated: Date.now(),
            wasOver: !!state.over,
            autoArchived,
            setupCode: keepCode,
          };
          broadcast(pin, state);

          let archived = false;

          // Pad 1: gebruiker drukt op Opslaan (idempotent via saveId)
          if (state.saved) {
            const saveId = state.saveId || ('auto-' + Date.now());
            if (!seenSaveIds[pin]) { seenSaveIds[pin] = new Set(); }
            if (!seenSaveIds[pin].has(saveId)) {
              seenSaveIds[pin].add(saveId);
              archiveMatch(pin, state);
              archived = true;
            }
          }

          // Pad 2: match liep gewoon af (over: false → true) en gebruiker
          // heeft niet expliciet op save gedrukt. Archiveer alsnog.
          if (!archived && state.over && !prev.wasOver && !prev.autoArchived) {
            archiveMatch(pin, state);
            matches[pin].autoArchived = true;
          }

          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 400, { error: 'Ongeldige JSON.' });
        }
      });
      return;
    }

    // Bord haalt stand op. Bestaat er nog geen wedstrijd? Geef een lege stand
    // terug (200) zodat het bord altijd kan verbinden met een geldige code en
    // gewoon wacht tot het horloge data stuurt — geen 404-foutmelding meer.
    if (req.method === 'GET') {
      const m = matches[pin];
      if (!m) { return sendJSON(res, 200, freshMatch()); }
      return sendJSON(res, 200, m.state);
    }
  }

  // --- Statische bestanden (het scorebord) ---
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
    const ext = path.extname(filePath);
    const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`PadelSmash server draait op poort ${PORT}`));
