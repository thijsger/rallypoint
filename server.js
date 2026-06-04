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

const PORT = process.env.PORT || 3000;
const TTL_MS = 1000 * 60 * 60 * 6; // live stand vervalt na 6 uur inactiviteit
const HISTORY_FILE = path.join(process.env.RENDER_DISK_PATH || __dirname, 'history.json');
const MAX_PER_PIN = 100;

const matches = {}; // pin -> { state, updated }
const clients = {}; // pin -> [res, ...]  (live SSE-verbindingen)
let history = {};   // pin -> [match, ...]  (afgesloten wedstrijden)
const seenSaveIds = {}; // pin -> Set(saveId)  voorkomt dubbele archivering bij retries

try {
  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '{}');
  }
} catch (e) { history = {}; }

let writeQueued = false;
function persistHistory() {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch (e) {}
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
    teamUs: typeof state.teamUs === 'string' ? state.teamUs : 'Us',
    teamThem: typeof state.teamThem === 'string' ? state.teamThem : 'Them',
    lang: typeof state.lang === 'string' ? state.lang : 'en',
  };
}

function archiveMatch(pin, state) {
  if (!history[pin]) { history[pin] = []; }
  history[pin].push(snapshotForHistory(state));
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
