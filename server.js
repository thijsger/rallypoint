// PadelSmash server — houdt per pincode een wedstrijdstand bij.
// Geen database nodig: alles in geheugen. Bij herstart begint het leeg,
// wat voor live wedstrijden prima is.
//
// Endpoints:
//   POST /match/:pin        -> horloge stuurt de volledige stand (JSON body)
//   GET  /match/:pin        -> bord haalt de stand op
//   POST /match/:pin/reset  -> wis de stand
//   GET  /                  -> serveert het scorebord (public/index.html)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TTL_MS = 1000 * 60 * 60 * 6; // stand vervalt na 6 uur inactiviteit

const matches = {}; // pin -> { state, updated }

function freshMatch() {
  return { points:[0,0], games:[0,0], sets:[0,0], over:false, winner:-1, history:[], golden:false, fmt:1 };
}

// Ruim oude wedstrijden periodiek op
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['match','1234','reset']

  // --- API ---
  if (parts[0] === 'match' && parts[1]) {
    const pin = parts[1];
    if (!validPin(pin)) { return sendJSON(res, 400, { error: 'Pincode moet 4 cijfers zijn.' }); }

    // Reset
    if (parts[2] === 'reset' && req.method === 'POST') {
      matches[pin] = { state: freshMatch(), updated: Date.now() };
      return sendJSON(res, 200, { ok: true });
    }

    // Horloge stuurt stand
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const state = JSON.parse(body || '{}');
          matches[pin] = { state, updated: Date.now() };
          sendJSON(res, 200, { ok: true });
        } catch (e) {
          sendJSON(res, 400, { error: 'Ongeldige JSON.' });
        }
      });
      return;
    }

    // Bord haalt stand op
    if (req.method === 'GET') {
      const m = matches[pin];
      if (!m) { return sendJSON(res, 404, { error: 'Geen wedstrijd met deze pincode.' }); }
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
