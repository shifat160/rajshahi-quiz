const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONTENT_DIR = path.join(__dirname, 'content');
const MAX_BOARD = 15;
const SESSION_TTL = 1000 * 60 * 20; // 20 min

// ---- storage ----
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RESULTS_FILE)) fs.writeFileSync(RESULTS_FILE, '[]');

function readResults() { try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch { return []; } }
function writeResults(l) { fs.writeFileSync(RESULTS_FILE, JSON.stringify(l, null, 2)); }
function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function loadConfig() { return readJSON(path.join(CONTENT_DIR, 'config.json'), {}); }
function loadQuestions() { return readJSON(path.join(CONTENT_DIR, 'questions.json'), { questions: [], serveCount: 10 }); }

// quiz sessions live in memory (single-instance booth app)
const sessions = new Map();
function cleanSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.startTime > SESSION_TTL) sessions.delete(k);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function emailPlayed(email, list) {
  const e = String(email || '').toLowerCase();
  return !!e && list.some(r => r.email && String(r.email).toLowerCase() === e);
}

// best per player, keyed by email; tie-break by faster time
function topBoard(list) {
  const best = {};
  for (const r of list) {
    const key = (r.email && String(r.email).toLowerCase()) || r.name;
    if (!key) continue;
    const cur = best[key];
    if (!cur || r.score > cur.score || (r.score === cur.score && (r.durationMs || 9e9) < (cur.durationMs || 9e9)))
      best[key] = r;
  }
  return Object.values(best)
    .sort((a, b) => b.score - a.score || (a.durationMs || 9e9) - (b.durationMs || 9e9))
    .slice(0, MAX_BOARD)
    .map(r => ({ name: r.name, flag: r.flag || '', country: r.country || '', score: r.score, total: r.total || 10 }));
}

function swagCounts(list) {
  const c = {};
  for (const r of list) if (r.swag && r.swag.item) c[r.swag.item] = (c[r.swag.item] || 0) + 1;
  return c;
}
// highest tier the score qualifies for that still has stock (falls back to lower tiers)
function assignSwag(score, list) {
  const swag = loadConfig().swag || {};
  const tiers = (swag.tiers || []).slice().sort((a, b) => b.min - a.min);
  const inv = swag.inventory || {};
  const counts = swagCounts(list);
  for (const t of tiers) {
    if (score >= t.min) {
      const remaining = (inv[t.item] == null ? Infinity : inv[t.item]) - (counts[t.item] || 0);
      if (remaining > 0) {
        const code = 'RAJ-' + (t.short || t.item.toUpperCase()) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
        return { item: t.item, emoji: t.emoji || '🎁', code };
      }
    }
  }
  return null;
}

// ---- http helpers ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req, cb) { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => cb(b)); }
function adminOK(url) { const t = url.searchParams.get('token'); return process.env.ADMIN_TOKEN && t === process.env.ADMIN_TOKEN; }
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // public config for the UI (no answers, ever)
  if (req.method === 'GET' && p === '/api/config') {
    const cfg = loadConfig(); const swag = cfg.swag || {}; const inv = swag.inventory || {};
    const counts = swagCounts(readResults()); const remaining = {};
    for (const k of Object.keys(inv)) remaining[k] = Math.max(0, inv[k] - (counts[k] || 0));
    return sendJSON(res, 200, {
      quizName: cfg.quizName || 'Rajshahi Quiz', tagline: cfg.tagline || '',
      perQuestionSeconds: cfg.perQuestionSeconds || 20, showRunningScore: cfg.showRunningScore !== false,
      minToWin: swag.minToWin != null ? swag.minToWin : 5, tiers: swag.tiers || [], remaining,
    });
  }

  if (req.method === 'GET' && p === '/api/check') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    return sendJSON(res, 200, { played: emailPlayed(email, readResults()) });
  }

  if (req.method === 'GET' && p === '/api/leaderboard') {
    return sendJSON(res, 200, { top: topBoard(readResults()) });
  }

  // start a quiz: build a session, send shuffled questions WITHOUT answers
  if (req.method === 'POST' && p === '/api/quiz/start') {
    return readBody(req, body => {
      let d; try { d = JSON.parse(body || '{}'); } catch { return sendJSON(res, 400, { error: 'bad request' }); }
      const name = String(d.name || '').trim().slice(0, 20);
      const email = String(d.email || '').trim().slice(0, 60);
      const country = String(d.country || '').trim().slice(0, 40);
      const flag = String(d.flag || '').trim().slice(0, 8);
      if (!name) return sendJSON(res, 400, { error: 'name required' });
      if (!EMAIL_RE.test(email)) return sendJSON(res, 400, { error: 'valid email required' });
      const list = readResults();
      if (emailPlayed(email, list)) return sendJSON(res, 409, { already: true, top: topBoard(list) });

      const qf = loadQuestions(); const cfg = loadConfig();
      const pool = (qf.questions || []).filter(q => Array.isArray(q.options) && q.options.length >= 2);
      const serveCount = Math.min(qf.serveCount || 10, pool.length);
      const picked = shuffle(pool).slice(0, serveCount);
      const ans = {}; const clientQs = [];
      for (const q of picked) {
        const opts = shuffle(q.options.map((t, i) => ({ t, i })));
        const correctIndex = opts.findIndex(o => o.i === q.answerIndex);
        const optionTexts = opts.map(o => o.t);
        ans[q.id] = { correctIndex, optionTexts, explanation: q.explanation || '', question: q.question };
        clientQs.push({ id: q.id, category: q.category || '', question: q.question, image: q.image || '', options: optionTexts });
      }
      cleanSessions();
      const sessionId = crypto.randomBytes(12).toString('hex');
      sessions.set(sessionId, { name, email, country, flag, ans, recorded: {}, startTime: Date.now(), total: serveCount });
      return sendJSON(res, 200, {
        sessionId, total: serveCount,
        perQuestionSeconds: cfg.perQuestionSeconds || 20,
        showRunningScore: cfg.showRunningScore !== false,
        questions: clientQs,
      });
    });
  }

  // lock one answer and reveal the correct option for THAT question only
  if (req.method === 'POST' && p === '/api/quiz/answer') {
    return readBody(req, body => {
      let d; try { d = JSON.parse(body || '{}'); } catch { return sendJSON(res, 400, { error: 'bad request' }); }
      const s = sessions.get(d.sessionId);
      if (!s) return sendJSON(res, 400, { error: 'session expired' });
      const meta = s.ans[d.id];
      if (!meta) return sendJSON(res, 400, { error: 'unknown question' });
      if (!(d.id in s.recorded)) {
        const choice = Number.isInteger(d.choiceIndex) ? d.choiceIndex : -1;
        s.recorded[d.id] = choice;
      }
      const choice = s.recorded[d.id];
      return sendJSON(res, 200, {
        correct: choice === meta.correctIndex,
        correctIndex: meta.correctIndex,
        explanation: meta.explanation,
      });
    });
  }

  // finalize: score from locked answers, persist, assign swag
  if (req.method === 'POST' && p === '/api/quiz/submit') {
    return readBody(req, body => {
      let d; try { d = JSON.parse(body || '{}'); } catch { return sendJSON(res, 400, { error: 'bad request' }); }
      const s = sessions.get(d.sessionId);
      if (!s) return sendJSON(res, 400, { error: 'session expired' });
      const list = readResults();
      if (emailPlayed(s.email, list)) { sessions.delete(d.sessionId); return sendJSON(res, 409, { already: true, top: topBoard(list) }); }
      let score = 0; const details = [];
      for (const id of Object.keys(s.ans)) {
        const meta = s.ans[id];
        const choice = id in s.recorded ? s.recorded[id] : -1;
        const ok = choice === meta.correctIndex; if (ok) score++;
        details.push({
          question: meta.question, ok,
          your: choice >= 0 ? meta.optionTexts[choice] : null,
          correct: meta.optionTexts[meta.correctIndex],
          explanation: meta.explanation,
        });
      }
      const total = s.total; const durationMs = Date.now() - s.startTime;
      const swag = assignSwag(score, list);
      list.push({ name: s.name, email: s.email, country: s.country, flag: s.flag, score, total, durationMs, swag, claimed: false, ts: Date.now() });
      writeResults(list);
      sessions.delete(d.sessionId);
      return sendJSON(res, 200, { score, total, details, swag, top: topBoard(list) });
    });
  }

  // ---- staff / admin ----
  if (req.method === 'GET' && p === '/api/staff') {
    if (!adminOK(url)) return sendJSON(res, 403, { error: 'forbidden' });
    const list = readResults(); const inv = (loadConfig().swag || {}).inventory || {};
    const winners = list.filter(r => r.swag).map(r => ({
      name: r.name, email: r.email, score: r.score, total: r.total,
      item: r.swag.item, code: r.swag.code, claimed: !!r.claimed, ts: r.ts,
    })).sort((a, b) => b.ts - a.ts);
    const counts = swagCounts(list); const claimed = {};
    for (const r of list) if (r.swag && r.claimed) claimed[r.swag.item] = (claimed[r.swag.item] || 0) + 1;
    const inventory = {};
    for (const k of Object.keys(inv)) inventory[k] = {
      total: inv[k], issued: counts[k] || 0, claimed: claimed[k] || 0, remaining: Math.max(0, inv[k] - (counts[k] || 0)),
    };
    return sendJSON(res, 200, { winners, inventory });
  }

  if (req.method === 'POST' && p === '/api/claim') {
    if (!adminOK(url)) return sendJSON(res, 403, { error: 'forbidden' });
    return readBody(req, body => {
      let d; try { d = JSON.parse(body || '{}'); } catch { return sendJSON(res, 400, { error: 'bad request' }); }
      const code = String(d.code || '').trim().toUpperCase();
      const list = readResults();
      const r = list.find(x => x.swag && x.swag.code === code);
      if (!r) return sendJSON(res, 404, { error: 'code not found' });
      if (r.claimed) return sendJSON(res, 200, { ok: true, already: true, item: r.swag.item, name: r.name });
      r.claimed = true; r.claimedAt = Date.now(); writeResults(list);
      return sendJSON(res, 200, { ok: true, item: r.swag.item, name: r.name });
    });
  }

  if (req.method === 'GET' && p === '/api/export') {
    if (!adminOK(url)) return sendJSON(res, 403, { error: 'forbidden' });
    const list = readResults();
    const header = ['name', 'email', 'country', 'score', 'total', 'swag', 'code', 'claimed', 'timestamp'];
    const lines = [header.join(',')];
    for (const r of list) lines.push([
      csvCell(r.name), csvCell(r.email), csvCell(r.country), csvCell(r.score), csvCell(r.total),
      csvCell(r.swag ? r.swag.item : ''), csvCell(r.swag ? r.swag.code : ''),
      csvCell(r.claimed ? 'yes' : 'no'), csvCell(new Date(r.ts || 0).toISOString()),
    ].join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rajshahi-quiz-leads.csv"' });
    return res.end(lines.join('\n'));
  }

  if (req.method === 'POST' && p === '/api/reset') {
    if (!adminOK(url)) return sendJSON(res, 403, { error: 'forbidden' });
    writeResults([]); sessions.clear();
    return sendJSON(res, 200, { ok: true, message: 'results cleared' });
  }

  // ---- static files ----
  let filePath = p === '/' ? '/index.html' : p;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Rajshahi Quiz running on http://0.0.0.0:${PORT}`);
  console.log(`Results: ${RESULTS_FILE}`);
});
