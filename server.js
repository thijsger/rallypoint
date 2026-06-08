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

// --- License / paywall (Lemon Squeezy + server-side trial) ---
// Trial: 3d server-side, gebonden aan een account (1 trial per user ever).
// Na trial: user kiest €2/mnd (LS subscription) of €10 lifetime (LS one-time).
// LS "Has free trial" setting moet UIT staan op de monthly variant. Webhooks
// zijn source of truth voor paid state.
const LS_STORE_SLUG = process.env.LS_STORE_SLUG || '';                // bv. "rallypoint" → rallypoint.lemonsqueezy.com
const LS_MONTHLY_VARIANT_ID = process.env.LS_MONTHLY_VARIANT_ID || '';
const LS_LIFETIME_VARIANT_ID = process.env.LS_LIFETIME_VARIANT_ID || '';
const LS_WEBHOOK_SECRET = process.env.LS_WEBHOOK_SECRET || '';
const TRIAL_DAYS = 3;
const BCRYPT_COST = 10;

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

console.log('[boot] LS_STORE_SLUG =', LS_STORE_SLUG || '(not set)');
console.log('[boot] LS_WEBHOOK_SECRET present =', !!LS_WEBHOOK_SECRET);

// --- License-status uit DB ---
// State per PIN: 'unclaimed' (PIN niet aan account gekoppeld), 'none' (account
// maar geen license), 'trial', 'active', 'expired'.
function licenseStateForPin(pin) {
  const owner = db.getPinOwner(pin);
  if (!owner) return { state: 'unclaimed', trial_used: false };
  const lic = db.getLicense(owner.user_id);
  if (!lic) return { state: 'none', trial_used: false, user_id: owner.user_id };

  const now = Date.now();
  const trialUsed = !!lic.trial_used_at;

  if (lic.plan === 'lifetime' && lic.status === 'active') {
    return { state: 'active', plan: 'lifetime', trial_used: trialUsed };
  }
  const expires = typeof lic.expires_at === 'number' ? lic.expires_at : null;
  if (expires && now > expires) {
    return { state: 'expired', plan: lic.plan || null, trial_used: trialUsed };
  }
  if (lic.status === 'trial') {
    const daysLeft = expires ? Math.max(0, Math.ceil((expires - now) / (24*60*60*1000))) : 0;
    return { state: 'trial', plan: null, days_left: daysLeft, trial_used: true };
  }
  if (lic.status === 'active' || lic.status === 'cancelled') {
    return { state: 'active', plan: lic.plan || 'monthly', trial_used: trialUsed };
  }
  return { state: lic.status || 'expired', plan: lic.plan, trial_used: trialUsed };
}

function hasAccessByPin(pin) {
  const s = licenseStateForPin(pin);
  return s.state === 'trial' || s.state === 'active';
}

function sendLicenseRequired(res, pin) {
  res.writeHead(402, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: 'license_required', pin, state: licenseStateForPin(pin).state }));
}

// Start trial voor een user. Idempotent. Eén trial per user ever.
function startTrialForUser(userId) {
  const lic = db.getLicense(userId) || {};
  const now = Date.now();
  // Al actieve license? Geef bestaande state terug.
  if (lic.status === 'trial' || lic.status === 'active' || lic.status === 'cancelled') {
    return { ok: true, alreadyActive: true };
  }
  if (lic.trial_used_at) {
    return { ok: false, error: 'trial_already_used' };
  }
  const expires = now + (TRIAL_DAYS * 24 * 60 * 60 * 1000);
  db.upsertLicense(userId, {
    status: 'trial',
    plan: null,
    trial_used_at: now,
    trial_ends_at: expires,
    expires_at: expires,
  });
  console.log('[trial] started user=' + userId + ' expires=' + new Date(expires).toISOString());
  return { ok: true };
}

function lsCheckoutUrl(plan, userId, pin) {
  const variantId = plan === 'lifetime' ? LS_LIFETIME_VARIANT_ID : LS_MONTHLY_VARIANT_ID;
  if (!LS_STORE_SLUG || !variantId) return null;
  // Custom data: user_id (gezagvol — webhook gebruikt dit) + pin (voor redirect-back).
  const successUrl = encodeURIComponent(`https://rallypoint.pro/?pin=${pin || ''}&licensed=1`);
  let url = `https://${LS_STORE_SLUG}.lemonsqueezy.com/checkout/buy/${variantId}` +
            `?checkout[custom][user_id]=${encodeURIComponent(String(userId))}` +
            `&checkout[success_url]=${successUrl}`;
  if (pin) { url += `&checkout[custom][pin]=${encodeURIComponent(pin)}`; }
  return url;
}

function handleLsWebhook(body, sigHeader) {
  if (!LS_WEBHOOK_SECRET) return { code: 503, msg: 'Webhook secret not set' };
  if (!sigHeader) return { code: 401, msg: 'No signature' };
  const expected = crypto.createHmac('sha256', LS_WEBHOOK_SECRET).update(body).digest('hex');
  try {
    const sigBuf = Buffer.from(String(sigHeader), 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { code: 401, msg: 'Bad signature' };
    }
  } catch (e) { return { code: 401, msg: 'Bad signature' }; }

  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch (e) { return { code: 400, msg: 'Bad JSON' }; }

  const event = payload.meta && payload.meta.event_name;
  const custom = (payload.meta && payload.meta.custom_data) || {};
  const data = payload.data || {};
  const attrs = data.attributes || {};
  const userIdRaw = custom.user_id;
  const userId = userIdRaw ? Number(userIdRaw) : null;
  if (!userId || !db.getUserById(userId)) {
    console.warn('[webhook]', event, 'unknown user_id in custom_data:', userIdRaw);
    return { code: 200, msg: 'OK (no user)' };
  }

  const now = Date.now();
  const fields = { customer_email: attrs.user_email || undefined };

  if (event === 'subscription_created') {
    const trialEnds = attrs.trial_ends_at ? Date.parse(attrs.trial_ends_at) : null;
    const renewsAt = attrs.renews_at ? Date.parse(attrs.renews_at) : null;
    fields.plan = 'monthly';
    fields.ls_subscription_id = String(data.id);
    fields.expires_at = trialEnds || renewsAt || null;
    fields.status = (trialEnds && trialEnds > now) ? 'trial' : 'active';
  } else if (event === 'subscription_updated' || event === 'subscription_payment_success' || event === 'subscription_resumed') {
    const renewsAt = attrs.renews_at ? Date.parse(attrs.renews_at) : null;
    fields.plan = 'monthly';
    if (renewsAt) { fields.expires_at = renewsAt; }
    if (attrs.status === 'on_trial') { fields.status = 'trial'; }
    else if (attrs.status === 'active') { fields.status = 'active'; }
  } else if (event === 'subscription_cancelled') {
    const endsAt = attrs.ends_at ? Date.parse(attrs.ends_at) : null;
    fields.status = 'cancelled';
    if (endsAt) { fields.expires_at = endsAt; }
  } else if (event === 'subscription_expired') {
    fields.status = 'expired';
    fields.expires_at = now;
  } else if (event === 'order_created') {
    const isSubOrder = attrs.first_subscription_id != null;
    if (isSubOrder) return { code: 200, msg: 'OK (subscription order, ignored)' };
    fields.plan = 'lifetime';
    fields.ls_order_id = String(data.id);
    fields.status = 'active';
    fields.expires_at = null;
  } else {
    console.log('[webhook] ignoring event:', event);
    return { code: 200, msg: 'OK (ignored)' };
  }

  db.upsertLicense(userId, fields);
  console.log('[webhook]', event, 'user=' + userId, 'status=' + fields.status, 'plan=' + fields.plan);
  return { code: 200, msg: 'OK' };
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

  // --- TTS proxy: /tts/:lang/:text?voice=<id>&pin=<pin> — ElevenLabs + cache
  // Gated: client moet PIN meegeven die access heeft (trial/active).
  if (parts[0] === 'tts' && req.method === 'GET' && parts.length >= 3) {
    const lang = parts[1];
    const text = decodeURIComponent(parts.slice(2).join('/'));
    const voice = url.searchParams.get('voice') || '';
    const pin = url.searchParams.get('pin') || '';
    if (!validPin(pin) || !hasAccessByPin(pin)) {
      res.writeHead(402, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      return res.end('License required');
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
        const { id, verifyToken } = db.createUser(email, hash);
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
    return sendJSON(res, 404, { error: 'Not found' });
  }

  // --- Account API (alle endpoints vereisen authenticated user) ---
  if (parts[0] === 'api' && parts[1] === 'account') {
    const user = getUserFromReq(req);
    if (!user) return sendJSON(res, 401, { error: 'not_authenticated' });

    if (parts[2] === 'couple-pin' && req.method === 'POST') {
      return readJsonBody(req).then(body => {
        const pin = String(body.pin || '');
        if (!validPin(pin)) return sendJSON(res, 400, { error: 'bad_pin' });
        const result = db.pairPin(pin, user.id);
        if (!result.ok) return sendJSON(res, 409, { error: result.error || 'cannot_pair' });
        return sendJSON(res, 200, { ok: true, pin, already_owned: !!result.alreadyOwned });
      }).catch(e => sendJSON(res, 400, { error: e.message || 'bad_request' }));
    }
    if (parts[2] === 'pins' && !parts[3] && req.method === 'GET') {
      return sendJSON(res, 200, db.getPinsForUser(user.id).map(p => p.pin));
    }
    if (parts[2] === 'pins' && parts[3] && req.method === 'DELETE') {
      const pin = parts[3];
      if (!validPin(pin)) return sendJSON(res, 400, { error: 'bad_pin' });
      db.unpairPin(pin, user.id);
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 404, { error: 'Not found' });
  }

  // --- License API ---
  if (parts[0] === 'api' && parts[1] === 'license') {
    if (parts[2] === 'status' && req.method === 'GET') {
      const pin = url.searchParams.get('pin') || '';
      if (!validPin(pin)) { return sendJSON(res, 400, { error: 'Bad pin' }); }
      return sendJSON(res, 200, licenseStateForPin(pin));
    }
    if (parts[2] === 'checkout' && req.method === 'GET') {
      const user = getUserFromReq(req);
      if (!user) {
        // Niet ingelogd → stuur naar login met return-redirect
        const plan = url.searchParams.get('plan') || '';
        const next = encodeURIComponent('/api/license/checkout?plan=' + plan);
        res.writeHead(302, { 'Location': '/account/login?next=' + next });
        return res.end();
      }
      const plan = url.searchParams.get('plan') || '';
      const pinParam = url.searchParams.get('pin') || '';
      if (plan !== 'monthly' && plan !== 'lifetime') { return sendJSON(res, 400, { error: 'Bad plan' }); }
      const target = lsCheckoutUrl(plan, user.id, validPin(pinParam) ? pinParam : '');
      if (!target) { return sendJSON(res, 503, { error: 'LS not configured' }); }
      res.writeHead(302, { 'Location': target });
      return res.end();
    }
    if (parts[2] === 'start-trial' && req.method === 'POST') {
      const user = getUserFromReq(req);
      if (!user) return sendJSON(res, 401, { error: 'not_authenticated' });
      const result = startTrialForUser(user.id);
      if (!result.ok) return sendJSON(res, 409, { error: result.error || 'cannot_start_trial' });
      return sendJSON(res, 200, { ok: true });
    }
    if (parts[2] === 'webhook' && req.method === 'POST') {
      const chunks = []; let total = 0;
      req.on('data', c => { chunks.push(c); total += c.length; if (total > 5e5) req.destroy(); });
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const result = handleLsWebhook(body, req.headers['x-signature']);
        res.writeHead(result.code, { 'Content-Type': 'text/plain' });
        res.end(result.msg);
      });
      return;
    }
    return sendJSON(res, 404, { error: 'Not found' });
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
    const pages = { '': 'index.html', 'login': 'login.html', 'signup': 'signup.html', 'forgot': 'forgot.html', 'reset': 'reset.html' };
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

  // --- Payment landing page: /p/:pin (watch verwijst gebruiker hierheen)
  if (parts[0] === 'p' && parts[1] && req.method === 'GET') {
    const pin = parts[1];
    if (!validPin(pin)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Pin niet geldig'); }
    const filePath = path.join(__dirname, 'public', 'pay.html');
    return fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Niet gevonden'); }
      const html = data.toString('utf8').replace(/__PIN__/g, pin);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
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
      if (!hasAccessByPin(pin)) { return sendLicenseRequired(res, pin); }
      const list = (history[pin] || []).slice().reverse(); // nieuwste eerst
      return sendJSON(res, 200, list);
    }
    if (req.method === 'DELETE') {
      if (!hasAccessByPin(pin)) { return sendLicenseRequired(res, pin); }
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
    if (!hasAccessByPin(pin)) { return sendLicenseRequired(res, pin); }

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
