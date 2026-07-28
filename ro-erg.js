#!/usr/bin/env node
// ro-erg.js — {{AGENT_NAME}} answers ONE parallel READ-ONLY request (the "ro lane").
//
// operator directive 2026-07-26 (input web-2026-07-26T11-08-50-212Z.txt): the
// watch-page's right column fires these — parallel Q&A ergs that run
// ALONGSIDE normal ergs (no erg.lock), may write their answer to ro/output/
// (+ /tmp, work/ro/ scratch, even outside the directory), but must NOT write
// the mind/memory stuff (mind/, short-term/, long-term/) nor the input/output
// of the main lane. Enforced two ways: permission deny-rules for Edit/Write
// (below) + an RO-OVERRIDE system-prompt block (Bash is honor-system for now).
//
// Usage: node ro-erg.js <name-of-file-in-ro/input>
//   - reads ro/input/<name> as the request
//   - runs one bare claude -p session (same mind + short-term index as a
//     normal erg, plus the RO override block)
//   - moves ro/input/<name> → ro/input/processed/ when done (mechanically,
//     here — the session itself never touches ro/input/)
//   - logs to ro/ro.log; ledger ro/ergs.jsonl; transcripts ro/ergs/
//   - maintains ro/running/<pid> so the web server can count live RO ergs
//
// Spawned by web/server.js POST /ro-ask (one ask = one immediate RO erg).

const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = __dirname;
const MIND = path.join(HOME, 'mind');
const SHORT = path.join(HOME, 'short-term');
const RO = path.join(HOME, 'ro');
const ROIN = path.join(RO, 'input');
const ROERGS = path.join(RO, 'ergs');
const LOG = path.join(RO, 'ro.log');
const LEDGER = path.join(RO, 'ergs.jsonl');
const RUNDIR = path.join(RO, 'running');
const PREF_FILE = path.join(HOME, 'tok-pref.json'); // read-only here (main lane owns it)

// ---- host.conf: per-host paths (gitignored; see host.conf.example) ----
const CONF = {};
try {
  for (const l of fs.readFileSync(path.join(HOME, 'host.conf'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && l.trim()[0] !== '#') CONF[m[1]] = m[2];
  }
} catch (_) {}

const CLAUDE = CONF.CLAUDE_BIN || 'claude'; // path to the claude CLI (or rely on PATH)
const MODEL = 'claude-fable-5';
const FALLBACK_MODEL = 'claude-opus-5'; // when fable weekly budget is dry (the operator 2026-07-27)
const TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,TodoWrite';
const TIMEOUT_MS = 30 * 60_000;

const log = (m) => { const l = new Date().toISOString() + ' [ro ' + process.pid + '] ' + m; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's'; };
const fmtTok = (n) => n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k' : (n / 1e6).toFixed(2) + 'M';

// ---- the request ----
const reqName = (process.argv[2] || '').trim();
if (!reqName || reqName.includes('/') || reqName.includes('..')) { console.error('usage: node ro-erg.js <file-in-ro/input>'); process.exit(2); }
const reqPath = path.join(ROIN, reqName);
let reqText = '';
try { reqText = fs.readFileSync(reqPath, 'utf8').trim(); } catch (e) { console.error('cannot read ' + reqPath + ': ' + e.message); process.exit(2); }

// ---- system prompt: mind/* + short-term index (same as erg.js) + RO override ----
function firstLine(p) {
  try { return (fs.readFileSync(p, 'utf8').split('\n').find((l) => l.trim()) || '(empty)').trim().slice(0, 200); }
  catch (_) { return '(unreadable)'; }
}
function buildSystemPrompt() {
  const parts = [];
  for (const f of fs.readdirSync(MIND).sort()) {
    const p = path.join(MIND, f);
    if (!fs.statSync(p).isFile()) continue;
    parts.push('━━━ mind file: mind/' + f + ' ━━━\n' + fs.readFileSync(p, 'utf8').trim());
  }
  const st = fs.readdirSync(SHORT).sort().filter((f) => fs.statSync(path.join(SHORT, f)).isFile());
  parts.push('━━━ short-term memory index (summary = first line of each file; Read a file for the rest) ━━━\n' +
    (st.length ? st.map((f) => '- short-term/' + f + ' — ' + firstLine(path.join(SHORT, f))).join('\n') : '(short-term/ is empty)'));
  parts.push([
    '━━━ RO OVERRIDE — this is a PARALLEL READ-ONLY erg (ro lane), NOT a normal erg ━━━',
    'You run CONCURRENTLY with normal ergs (no lock). The mind above is your identity',
    'and context, but its erg-cycle duties are OVERRIDDEN as follows:',
    '- ONLY task: answer/handle the single request in this prompt (from the operator\'s',
    '  right-column ask box). NO input/ processing, NO thread work, NO stream triage,',
    '  NO short-term/long-term updates — even if the mind says otherwise.',
    '- WRITES: allowed ONLY to ro/output/ (deliverables), work/ro/ (scratch), /tmp.',
    '  FORBIDDEN — deny-rules block Edit/Write and you must honor it in Bash too:',
    '  mind/, short-term/, long-term/, input/, output/ (main lane), web/, stream/,',
    '  ergs/, ro/input/, erg.js, ro-erg.js, erg.log, ergs.jsonl, tok-pref.json.',
    '  If the request truly requires a memory/state write, SAY SO in your answer',
    '  file (a normal erg will pick it up) — never do it yourself.',
    '- Shared checkouts under work/*/repo may have branches checked out by the main',
    '  lane — read freely, NEVER checkout/commit/mutate them. Need a repo? Clone your',
    '  own under work/ro/.',
    '- LOG to ro/ro.log (NOT erg.log), same protocol: one PLAN line first',
    '  (`echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [ro-erg] PLAN: …" >> ro/ro.log`),',
    '  STEP/NOTE sparingly, DONE at the end.',
    '- DELIVERABLE: at least one file in ro/output/ (this is what the operator\'s right',
    '  column shows). Same card conventions: first line = one-sentence summary,',
    '  line 2 = `priority: importance=N urgency=N`, self-contained, links included.',
    '- External actions (Slack/Jira/email/PRs) still require the operator\'s word — for an',
    '  RO erg that means: draft into ro/output/ and stop. Never fire ergs',
    '  (no POST /erg, /ro-ask, no spawning erg.js/ro-erg.js).',
  ].join('\n'));
  return parts.join('\n\n');
}

// write-protection: deny rules for Edit/Write. MUST be absolute (`//path`)
// patterns — relative ones like `Write(output/**)` match ANY output/ segment
// (verified empirically 2026-07-26 in /tmp/rotest: `output/**` also denied
// ro/output/, which is exactly the answer channel). Bash writes are partially
// caught by the CLI's command analysis; the RO-OVERRIDE prompt covers the rest.
const DENY = ['mind/**', 'short-term/**', 'long-term/**', 'input/**', 'output/**',
  'web/**', 'stream/**', 'ergs/**', 'ro/input/**', 'ro/running/**', 'ro/ergs/**',
  'erg.js', 'ro-erg.js', 'erg.log', 'ergs.jsonl', 'tok-pref.json']
  .flatMap((p) => ['Edit(/' + HOME + '/' + p + ')', 'Write(/' + HOME + '/' + p + ')']);
const SETTINGS = JSON.stringify({ permissions: { deny: DENY } });

// ---- auth: same sticky-token scheme as erg.js, but NEVER writes tok-pref.json ----
let envText = '';
try { if (CONF.OAUTH_ENV_FILE) envText = fs.readFileSync(CONF.OAUTH_ENV_FILE, 'utf8'); } catch (_) {}
const TOKS = [
  (envText.match(/^CLAUDE_CODE_OAUTH_TOKEN=(\S+)/m) || [, ''])[1] || process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
  (envText.match(/^CLAUDE_CODE_OAUTH_TOKEN_2=(\S+)/m) || [, ''])[1] || process.env.CLAUDE_CODE_OAUTH_TOKEN_2 || '',
].filter(Boolean);
const baseEnv = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
delete baseEnv.ANTHROPIC_API_KEY;
const LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|out of.*(quota|usage)|exceeded.*limit|\b429\b/i;
let prefSlot = 1;
try {
  const p = JSON.parse(fs.readFileSync(PREF_FILE, 'utf8')).slot;
  if (Number.isInteger(p) && p >= 1 && p <= TOKS.length) prefSlot = p;
} catch (_) {}
const SLOT_ORDER = [prefSlot, ...TOKS.map((_, i) => i + 1).filter((s) => s !== prefSlot)];

// ---- fable-budget fallback probe (mirrors erg.js; operator directive 2026-07-27) ----
// 1-token direct-API check (~35 tok, ~1s) of whether THIS (token, model) pair is
// currently accepted. Definite rejection (429 / unified status "rejected") skips
// the attempt; probe errors count as allowed. Token goes via env, not argv.
const PROBE_SRC = "const https=require('https');" +
  "const body=JSON.stringify({model:process.argv[1],max_tokens:1," +
  "system:\"You are Claude Code, Anthropic's official CLI for Claude.\"," +
  "messages:[{role:'user',content:'hi'}]});" +
  "const q=https.request({host:'api.anthropic.com',path:'/v1/messages',method:'POST'," +
  "headers:{Authorization:'Bearer '+process.env.PROBE_TOK,'anthropic-beta':'oauth-2025-04-20'," +
  "'anthropic-version':'2023-06-01','content-type':'application/json'," +
  "'content-length':Buffer.byteLength(body)},timeout:20000},r=>{r.resume();" +
  "r.on('end',()=>console.log(JSON.stringify({http:r.statusCode," +
  "status:r.headers['anthropic-ratelimit-unified-status']||null})))});" +
  "q.on('error',e=>console.log(JSON.stringify({error:e.message})));" +
  "q.on('timeout',()=>{q.destroy();console.log(JSON.stringify({error:'timeout'}))});" +
  "q.end(body);";
function modelAllowed(tok, model) {
  try {
    const pr = spawnSync(process.execPath, ['-e', PROBE_SRC, model],
      { env: { ...process.env, PROBE_TOK: tok }, encoding: 'utf8', timeout: 25000 });
    const o = JSON.parse((pr.stdout || '').trim());
    if (o.http === 429 || o.status === 'rejected') return false;
  } catch (_) {}
  return true;
}

// ---- run (no lock — RO ergs are parallel by design) ----
const PIDF = path.join(RUNDIR, String(process.pid));
try { fs.mkdirSync(RUNDIR, { recursive: true }); fs.writeFileSync(PIDF, reqName); } catch (_) {}
try {
  const prompt = '[ro-erg ' + new Date().toISOString().slice(0, 16) + 'Z] PARALLEL READ-ONLY request' +
    ' (ro/input/' + reqName + ' — already read for you; do NOT process input/):\n\n' + reqText;
  const sysPrompt = buildSystemPrompt();
  // preferred model on every token, then the fallback model on every token
  // (model is NOT sticky — each ro-erg re-probes fable first, so the lane
  // returns to it automatically when the weekly bucket refills)
  const PLAN = [];
  for (const m of [MODEL, FALLBACK_MODEL]) for (const s of SLOT_ORDER) PLAN.push({ slot: s, model: m });

  let r, res, ok = false, sid, t0, tokSlot = 1, model = MODEL, ran = false;
  const skipped = [];
  for (let attempt = 0; attempt < PLAN.length; attempt++) {
    tokSlot = PLAN[attempt].slot; model = PLAN[attempt].model;
    if (TOKS[tokSlot - 1] && !modelAllowed(TOKS[tokSlot - 1], model)) {
      skipped.push(model + '@tok' + tokSlot);
      log('budget probe: ' + model + ' rejected on token ' + tokSlot + ' — skipping');
      continue;
    }
    sid = crypto.randomUUID();
    const env = { ...baseEnv };
    if (TOKS[tokSlot - 1]) env.CLAUDE_CODE_OAUTH_TOKEN = TOKS[tokSlot - 1];
    const args = ['-p', prompt, '--output-format', 'json',
      '--model', model,
      '--setting-sources', 'user',
      '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--allowedTools', TOOLS, '--permission-mode', 'dontAsk',
      '--settings', SETTINGS,
      '--system-prompt', sysPrompt,
      '--session-id', sid];
    t0 = Date.now(); ran = true;
    log('ro-erg begins ' + sid +
      (model !== MODEL ? ' [' + model + ' — fable budget dry]' : '') +
      (attempt ? ' (RETRY on token ' + tokSlot + ' after limit)' : '') +
      ' :: ' + reqText.slice(0, 100).replace(/\n/g, ' '));
    r = spawnSync(CLAUDE, args, { cwd: HOME, env, encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024, timeout: TIMEOUT_MS });
    res = null; try { res = JSON.parse(r.stdout); } catch (_) {}
    ok = !!res && !res.is_error && r.status === 0;
    if (ok) break;
    const errTxt = (((res && res.result) || '') + ' ' + (r.stderr || '')).slice(0, 2000);
    if (attempt + 1 < PLAN.length && LIMIT_RE.test(errTxt)) {
      const nxt = PLAN[attempt + 1];
      log('LIMIT HIT on ' + model + '/token ' + tokSlot + ' — retrying on ' + nxt.model + '/token ' + nxt.slot);
      fs.appendFileSync(LEDGER, JSON.stringify({ sid, start: new Date(t0).toISOString(),
        ms: Date.now() - t0, ok: false, limitHit: true, tokSlot, model, req: reqName }) + '\n');
      continue;
    }
    break;
  }
  if (!ran) { // every (token, model) pair pre-rejected — nothing was launched
    res = { result: 'no attempt made: all (token, model) pairs rejected by budget probe [' + skipped.join(', ') + ']' };
    ok = false; sid = sid || 'no-session'; t0 = t0 || Date.now();
  }
  const u = res?.usage || null;
  const tok = u ? { in: (u.input_tokens || 0), cached: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: (u.output_tokens || 0) } : null;
  fs.appendFileSync(LEDGER, JSON.stringify({ sid, start: new Date(t0).toISOString(),
    ms: Date.now() - t0, cost: res?.total_cost_usd ?? null, turns: res?.num_turns ?? null,
    tok, ok, tokSlot: tokSlot > 1 ? tokSlot : undefined,
    model: model !== MODEL ? model : undefined, req: reqName }) + '\n');
  if (ran) try {
    const tf = path.join(os.homedir(), '.claude', 'projects', HOME.replace(/[\/._]/g, '-'), sid + '.jsonl');
    if (fs.existsSync(tf)) {
      fs.mkdirSync(ROERGS, { recursive: true });
      fs.copyFileSync(tf, path.join(ROERGS, new Date(t0).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z--' + sid + '.jsonl'));
    }
  } catch (_) {}
  // the request is handled (or failed visibly) — move it to processed/ mechanically
  try { fs.renameSync(reqPath, path.join(ROIN, 'processed', reqName)); } catch (_) {}
  log((ok ? 'ro-erg done ' : 'RO-ERG FAILED ') + sid +
    (tokSlot > 1 ? ' [token ' + tokSlot + ']' : '') +
    (model !== MODEL ? ' [' + model + ']' : '') +
    ' — took ' + fmtDur(Date.now() - t0) +
    ', cost ' + (res?.total_cost_usd != null ? '$' + res.total_cost_usd.toFixed(2) : '$?') +
    (res?.num_turns != null ? ' (' + res.num_turns + ' turns)' : '') +
    (tok ? ', tok ' + fmtTok(tok.in + tok.cached) + ' in (' + fmtTok(tok.cached) + ' cached) / ' + fmtTok(tok.out) + ' out' : '') +
    (ok ? '' : ' :: ' + ((res?.result || r.stderr || 'exit ' + r.status) + '').slice(0, 300)));
  if (ok && res.result) {
    const said = String(res.result).replace(/\n/g, ' | ');
    log('ro-erg said: ' + (said.length > 800 ? said.slice(0, 800) + ' …[cut]' : said));
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  try { fs.unlinkSync(PIDF); } catch (_) {}
}
