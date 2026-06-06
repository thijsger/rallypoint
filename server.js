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

const matches = {}; // pin -> { state, updated }
const clients = {}; // pin -> [res, ...]  (live SSE-verbindingen)
let history = {};   // pin -> [match, ...]  (afgesloten wedstrijden)
const seenSaveIds = {}; // pin -> Set(saveId)  voorkomt dubbele archivering bij retries

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

  // --- TTS proxy: /tts/:lang/:text?voice=<id> — ElevenLabs spraak + disk-cache
  if (parts[0] === 'tts' && req.method === 'GET' && parts.length >= 3) {
    const lang = parts[1];
    const text = decodeURIComponent(parts.slice(2).join('/'));
    const voice = url.searchParams.get('voice') || '';
    handleTts(req, res, lang, text, voice);
    return;
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

  // --- Match API ---
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
      broadcast(pin, state);
      return sendJSON(res, 200, { ok: true });
    }

    // Horloge stuurt stand
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const state = JSON.parse(body || '{}');
          const prev = matches[pin] || { wasOver: false, autoArchived: false };

          // Nieuwe match begonnen (over flip true→false): auto-archive flag resetten
          let autoArchived = prev.autoArchived;
          if (prev.wasOver && !state.over) { autoArchived = false; }

          matches[pin] = {
            state,
            updated: Date.now(),
            wasOver: !!state.over,
            autoArchived,
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
