// server.js — {{AGENT_NAME}}'s workbench window: https://{{HOST}}:{{PORT}}/#k=<key>
//
// Shows, live (3s poll):
//   - erg.log tail (the PLAN:/STEP:/DONE: lines = what {{AGENT_NAME}} decided to do)
//   - whether an erg is in flight (erg.lock + pid alive)
//   - output/ files as they appear; "mark read" moves one to output/processed/
// Lets the operator:
//   - drop an input file (textarea → input/web-<ts>.txt)
//   - fire an erg (▶ button → spawns `node erg.js` detached; N clicks = N ergs)
//
// Auth: every API call needs ?k=<key> (web/key.txt). Page stores it from #k=.
// TLS: house certs. Run: screen "{{AGENT_NAME}}-web"; @reboot cron tagged # {{AGENT_NAME}}-web.

const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');
const { spawn } = require('child_process');

const BOOT = Date.now(); // part of the page version: restart => clients reload

const PORT = {{PORT}};
const HOME = path.join(__dirname, '..');
const INPUT = path.join(HOME, 'input');
const OUTPUT = path.join(HOME, 'output');
const OUTDONE = path.join(OUTPUT, 'processed');
const REPORTS = path.join(OUTPUT, 'reports'); // <base>.html companions to output/<base>.md cards
const LOGF = path.join(HOME, 'erg.log');
const LOCKF = path.join(HOME, 'erg.lock');
// ro lane (operator directive 2026-07-26): parallel READ-ONLY ergs — right column.
// One POST /ro-ask = one immediate `node ro-erg.js <file>` (no erg.lock, runs
// alongside normal ergs). Their deliverables live in ro/output/ only.
const RO = path.join(HOME, 'ro');
const ROIN = path.join(RO, 'input');
const ROOUT = path.join(RO, 'output');
const ROOUTDONE = path.join(ROOUT, 'processed');
const ROLOGF = path.join(RO, 'ro.log');
const RORUN = path.join(RO, 'running');
for (const d of [path.join(ROIN, 'processed'), ROOUTDONE, RORUN]) fs.mkdirSync(d, { recursive: true });
const KEY = fs.readFileSync(path.join(__dirname, 'key.txt'), 'utf8').trim();
// ---- host.conf: per-host paths (gitignored; see ../host.conf.example) ----
const CONF = {};
try {
  for (const l of fs.readFileSync(path.join(HOME, 'host.conf'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && l.trim()[0] !== '#') CONF[m[1]] = m[2];
  }
} catch (_) {}
const CERT = CONF.TLS_CERT || '', KEYF = CONF.TLS_KEY || '';

const log = (m) => console.log(new Date().toISOString() + ' ' + m);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

function ergRunning() {
  try { const pid = parseInt(fs.readFileSync(LOCKF, 'utf8'), 10); return !!pid && alive(pid); }
  catch (_) { return false; }
}
function roRunning() { // count live RO ergs (ro-erg.js keeps ro/running/<pid>); clean stale files
  let n = 0;
  try {
    for (const f of fs.readdirSync(RORUN)) {
      const pid = parseInt(f, 10);
      if (pid && alive(pid)) n++;
      else { try { fs.unlinkSync(path.join(RORUN, f)); } catch (_) {} }
    }
  } catch (_) {}
  return n;
}
function listDir(dir, processed) {
  let out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      out.push({ name: f, t: st.mtimeMs, processed: !!processed,
                 text: fs.readFileSync(p, 'utf8').slice(0, 20000) });
    }
  } catch (_) {}
  return out;
}
// version = server boot time + hash of page.html: page reloads itself when
// either changes (new server code => restart => new BOOT; edited page.html
// is picked up per-request, so ver flips even without a restart)
function pageVer() {
  try { return BOOT + ':' + crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'page.html'))).digest('hex').slice(0, 12); }
  catch (_) { return BOOT + ':?'; }
}
function state() {
  let logTail = '';
  try {
    const raw = fs.readFileSync(LOGF, 'utf8');
    logTail = raw.split('\n').slice(-200).join('\n');
  } catch (_) { logTail = '(no erg.log yet)'; }
  // archived (processed) outputs are NOT shown — the page lists only unread ones
  const outputs = listDir(OUTPUT).sort((a, b) => b.t - a.t).slice(0, 100);
  const inputs = [...listDir(INPUT), ...listDir(path.join(INPUT, 'processed'), true)]
    .sort((a, b) => b.t - a.t).slice(0, 50).map(({ text, ...rest }) => ({ ...rest, text: text.slice(0, 2000) }));
  // reports = output/reports/*.html; the page shows a "diff report" button on
  // the output card whose basename matches (X.md ↔ reports/X.html)
  let reports = [];
  try { reports = fs.readdirSync(REPORTS).filter((f) => f.endsWith('.html')); } catch (_) {}
  // ro lane state (right column)
  let roLog = '';
  try { roLog = fs.readFileSync(ROLOGF, 'utf8').split('\n').slice(-120).join('\n'); }
  catch (_) { roLog = '(no ro.log yet — ask something)'; }
  const roOutputs = listDir(ROOUT).sort((a, b) => b.t - a.t).slice(0, 100);
  const roInputs = [...listDir(ROIN), ...listDir(path.join(ROIN, 'processed'), true)]
    .sort((a, b) => b.t - a.t).slice(0, 50).map(({ text, ...rest }) => ({ ...rest, text: text.slice(0, 2000) }));
  const ro = { running: roRunning(), log: roLog, outputs: roOutputs, inputs: roInputs };
  return { ok: true, ver: pageVer(), running: ergRunning(), log: logTail, outputs, inputs, reports, ro };
}
let lastPost = 0, lastRoPost = 0;

// ---- rate-limit panel (ported from ariadne, operator ask 2026-07-27 12:52Z) ----
// NO background polling. The erg pipeline (`claude -p`) never surfaces the
// anthropic-ratelimit-unified-* headers anywhere on disk, so "data from the
// most recent erg" can't be read passively; instead the PAGE asks /limits
// with probe=1 exactly when an erg finishes while the operator is watching (running
// true→false transition), on load if the cache is stale, or via ↻. A probe =
// one 1-token claude-fable-5 call per token (~33 tok each; fable because
// only fable requests carry the 7d_oi "fable weekly" bucket). Server-side
// debounce: at most one probe per PROBE_MIN_MS regardless of requests.
// Cache: web/limits.json (survives restarts).
const LIMITSF = path.join(__dirname, 'limits.json');
const ENVF = CONF.OAUTH_ENV_FILE || ''; // same env file the erg loop reads tokens from
const PROBE_MIN_MS = 90_000;
let probing = null;
function readToks() {
  try {
    const t = fs.readFileSync(ENVF, 'utf8');
    return [
      (t.match(/^CLAUDE_CODE_OAUTH_TOKEN=(\S+)/m) || [, ''])[1],
      (t.match(/^CLAUDE_CODE_OAUTH_TOKEN_2=(\S+)/m) || [, ''])[1],
    ];
  } catch (_) { return []; }
}
function probeOne(tok, slot) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'claude-fable-5', max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: 'hi' }] });
    const req = require('https').request({
      host: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok,
        'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 20000 }, (r) => {
      r.resume();  // drain body; everything we need is in the headers
      const h = r.headers;
      const g = (k) => h['anthropic-ratelimit-unified-' + k];
      const bucket = (k) => g(k + '-utilization') === undefined ? null : {
        util: +g(k + '-utilization'),
        reset: (+g(k + '-reset') * 1000) || null,
        status: g(k + '-status') || null };
      r.on('end', () => resolve({ slot, http: r.statusCode, status: g('status') || null,
        buckets: { '5h': bucket('5h'), '7d': bucket('7d'), '7d_oi': bucket('7d_oi') } }));
    });
    req.on('error', (e) => resolve({ slot, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ slot, error: 'timeout' }); });
    req.end(body);
  });
}
function readLimitsCache() {
  try { return JSON.parse(fs.readFileSync(LIMITSF, 'utf8')); } catch (_) { return null; }
}
function probeLimits(why) {
  const toks = readToks();
  return Promise.all(toks.map((t, i) => t ? probeOne(t, i + 1) : null).filter(Boolean))
    .then((slots) => {
      const data = { at: Date.now(), why: why || '', slots };
      try { fs.writeFileSync(LIMITSF, JSON.stringify(data, null, 1)); } catch (_) {}
      log('limits probed (' + (why || '?') + '): ' + slots.map((s) =>
        'tok' + s.slot + ' ' + (s.error ? 'ERR ' + s.error :
          ['5h', '7d', '7d_oi'].map((b) => b + '=' + (s.buckets[b] ? s.buckets[b].util : '?')).join(' '))).join(' | '));
      return data;
    });
}

function fireErg() { // spawn one erg.js, detached; erg.lock serializes N spawns into N queued ergs
  const child = spawn(process.execPath, [path.join(HOME, 'erg.js')],
    { cwd: HOME, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

const handler = (req, res) => {
  const url = new URL(req.url, 'https://x');
  const ok = url.searchParams.get('k') === KEY;
  const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'page.html'))); }
  if (!ok) return j(403, { ok: false, error: 'bad key' });

  if (url.pathname === '/state') return j(200, state());

  if (url.pathname === '/limits') { // cached rate-limit dials; probe=1 = refresh if debounce allows
    const cached = readLimitsCache();
    const age = cached ? Date.now() - cached.at : Infinity;
    if (url.searchParams.get('probe') === '1' && !probing && age > PROBE_MIN_MS)
      probing = probeLimits(url.searchParams.get('why') || 'page').finally(() => { probing = null; });
    if (url.searchParams.get('probe') === '1' && probing) {
      probing.then((d) => j(200, { ok: true, ...d }))
             .catch(() => j(200, { ok: true, ...(cached || { at: 0, slots: [] }) }));
      return;
    }
    return j(200, { ok: true, ...(cached || { at: 0, slots: [] }) });
  }

  if (url.pathname === '/report') { // serve an HTML report from output/reports/ (key-gated)
    const name = url.searchParams.get('name') || '';
    if (!name || name.includes('/') || name.includes('..') || !name.endsWith('.html'))
      return j(400, { ok: false, error: 'bad name' });
    const p = path.join(REPORTS, name);
    if (!fs.existsSync(p)) return j(404, { ok: false, error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(p));
  }

  if (url.pathname === '/input' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 200000) req.destroy(); });
    req.on('end', () => {
      let text = '';
      try { text = String(JSON.parse(b).text || '').trim(); } catch (_) {}
      if (!text) return j(400, { ok: false, error: 'empty' });
      if (Date.now() - lastPost < 1500) return j(429, { ok: false, error: 'slow down' });
      lastPost = Date.now();
      const name = 'web-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
      fs.writeFileSync(path.join(INPUT, name), text + '\n');
      // Card replies auto-queue an erg (ported from ariadne, operator ask
      // 2026-07-27 12:53Z): erg.js serializes via erg.lock, so this waits its
      // turn if one is in flight. Plain drop-ins still do NOT auto-run
      // (▶ stays manual for those).
      if (/^REPLY from operator to output\//.test(text)) {
        const pid = fireErg();
        log('input: ' + name + ' (' + text.length + ' chars) — reply, erg queued (pid ' + pid + ')');
        return j(200, { ok: true, name, erg: pid });
      }
      log('input: ' + name + ' (' + text.length + ' chars)');
      return j(200, { ok: true, name });
    });
    return;
  }
  if (url.pathname === '/ro-ask' && req.method === 'POST') {
    // right column: write the request into ro/input/ AND immediately fire a
    // parallel read-only erg on it (unlike /input, which never runs anything)
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 200000) req.destroy(); });
    req.on('end', () => {
      let text = '';
      try { text = String(JSON.parse(b).text || '').trim(); } catch (_) {}
      if (!text) return j(400, { ok: false, error: 'empty' });
      if (Date.now() - lastRoPost < 1500) return j(429, { ok: false, error: 'slow down' });
      lastRoPost = Date.now();
      const name = 'roq-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
      fs.writeFileSync(path.join(ROIN, name), text + '\n');
      const child = spawn(process.execPath, [path.join(HOME, 'ro-erg.js'), name],
        { cwd: HOME, detached: true, stdio: 'ignore' });
      child.unref();
      log('ro-ask: ' + name + ' (' + text.length + ' chars) → ro-erg pid ' + child.pid);
      return j(200, { ok: true, name, pid: child.pid });
    });
    return;
  }
  if (url.pathname === '/ro-archive' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 5000) req.destroy(); });
    req.on('end', () => {
      let name = '';
      try { name = String(JSON.parse(b).name || ''); } catch (_) {}
      if (!name || name.includes('/') || name.includes('..')) return j(400, { ok: false, error: 'bad name' });
      const src = path.join(ROOUT, name);
      if (!fs.existsSync(src)) return j(404, { ok: false, error: 'not found' });
      fs.renameSync(src, path.join(ROOUTDONE, name));
      log('archived ro output: ' + name);
      return j(200, { ok: true });
    });
    return;
  }
  if (url.pathname === '/archive' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 5000) req.destroy(); });
    req.on('end', () => {
      let name = '';
      try { name = String(JSON.parse(b).name || ''); } catch (_) {}
      if (!name || name.includes('/') || name.includes('..')) return j(400, { ok: false, error: 'bad name' });
      const src = path.join(OUTPUT, name);
      if (!fs.existsSync(src)) return j(404, { ok: false, error: 'not found' });
      fs.mkdirSync(OUTDONE, { recursive: true });
      fs.renameSync(src, path.join(OUTDONE, name));
      log('archived output: ' + name);
      return j(200, { ok: true });
    });
    return;
  }
  if (url.pathname === '/erg' && req.method === 'POST') {
    const pid = fireErg();
    log('erg fired (pid ' + pid + ')');
    return j(200, { ok: true, pid });
  }
  res.writeHead(404); res.end('{"ok":false}');
};

// TLS if host.conf names cert+key; otherwise plain HTTP (fine behind a proxy
// or on localhost — but the key in the URL is then visible on the wire).
const certs = () => ({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEYF) });
let server;
if (CERT && KEYF) {
  server = https.createServer(certs(), handler);
  fs.watchFile(CERT, () => { try { server.setSecureContext(certs()); log('certs reloaded'); } catch (e) { log('cert reload failed: ' + e.message); } });
} else {
  server = require('http').createServer(handler);
  log('WARNING: no TLS_CERT/TLS_KEY in host.conf — serving plain HTTP');
}
server.listen(PORT, () => log('{{AGENT_NAME}}-web listening on :' + PORT));
