#!/usr/bin/env node
// erg.js — {{AGENT_NAME}} performs one erg (one unit of work).
//
// Semantics: N invocations => N ergs, always serialized. If an erg is already
// in flight, this invocation WAITS for it to finish, then performs its own.
// Lock: erg.lock (pid inside; stale locks from dead pids are cleared).
//
// Each erg is a fresh, bare-bones `claude -p` session — no CLAUDE.md, no
// skills, no auto-memory. Continuity lives ONLY in the directory:
//   mind/        system prompt = concatenation of these files (lexicographic),
//                each block labeled with its filename (self-editable psyche)
//   short-term/  every erg's system prompt lists each file with its summary
//                (= the file's FIRST LINE)
//   long-term/   not listed — searched on demand (Grep/Glob)
//   input/       work + messages from outside     output/  results to outside
//   ergs/        archive: full transcript of every erg, copied here on finish
//
// The session itself appends PLAN:/STEP:/NOTE: lines to erg.log (protocol in
// mind/00-core.md) so the operator can watch what it decided to do, live.
//
// Usage: node erg.js ["optional extra context for this erg"]
// Log: erg.log   Ledger: ergs.jsonl

const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = __dirname;
const MIND = path.join(HOME, 'mind');
const SHORT = path.join(HOME, 'short-term');
const ERGS = path.join(HOME, 'ergs');
const LOCK = path.join(HOME, 'erg.lock');
const LOG = path.join(HOME, 'erg.log');
const LEDGER = path.join(HOME, 'ergs.jsonl');

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
const WAIT_LOG_EVERY = 150; // log "still waiting" every N polls (2s each) => every 5 min

const log = (m) => { const l = new Date().toISOString() + ' [' + process.pid + '] ' + m; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const sleep2 = () => spawnSync('sleep', ['2']);
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's'; };
const fmtTok = (n) => n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k' : (n / 1e6).toFixed(2) + 'M';

// ---- acquire the erg lock (wait for any in-flight erg to finish) ----
let waited = 0;
for (;;) {
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; }
  catch (_) {
    let holder = 0; try { holder = parseInt(fs.readFileSync(LOCK, 'utf8'), 10); } catch (_) {}
    if (!holder || !alive(holder)) { try { fs.unlinkSync(LOCK); } catch (_) {} continue; }
    if (waited === 0) log('erg in flight (pid ' + holder + ') — queued, waiting my turn');
    if (++waited % WAIT_LOG_EVERY === 0) log('still waiting on pid ' + holder + ' (' + waited * 2 + 's)');
    sleep2();
  }
}

// ---- build the system prompt: mind/* + short-term index ----
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
  return parts.join('\n\n');
}

// ---- auth: subscription oauth only; tok1 primary, tok2 fallback on limit ----
// Tokens come from the env file named in host.conf (OAUTH_ENV_FILE), falling
// back to this process's own environment.
let envText = '';
try { if (CONF.OAUTH_ENV_FILE) envText = fs.readFileSync(CONF.OAUTH_ENV_FILE, 'utf8'); } catch (_) {}
const TOKS = [
  (envText.match(/^CLAUDE_CODE_OAUTH_TOKEN=(\S+)/m) || [, ''])[1] || process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
  (envText.match(/^CLAUDE_CODE_OAUTH_TOKEN_2=(\S+)/m) || [, ''])[1] || process.env.CLAUDE_CODE_OAUTH_TOKEN_2 || '',
].filter(Boolean);
const baseEnv = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }; // no auto-memory
delete baseEnv.ANTHROPIC_API_KEY;                                         // never bill cash by accident
// A failed run whose error text matches this = rate/usage limit → worth retrying
// on the other subscription token (both are the operator's; directive 2026-07-26).
const LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|out of.*(quota|usage)|exceeded.*limit|\b429\b/i;
// Sticky token memory (operator directive 2026-07-26): each erg STARTS on the slot
// that last succeeded (tok-pref.json); a limit-triggered fallback that succeeds
// flips the memory, so the fleet stays on the healthy token until IT limits out.
const PREF_FILE = path.join(HOME, 'tok-pref.json');
let prefSlot = 1;
try {
  const p = JSON.parse(fs.readFileSync(PREF_FILE, 'utf8')).slot;
  if (Number.isInteger(p) && p >= 1 && p <= TOKS.length) prefSlot = p;
} catch (_) {}
// attempt order: remembered slot first, then the rest (1-based slots)
const SLOT_ORDER = [prefSlot, ...TOKS.map((_, i) => i + 1).filter((s) => s !== prefSlot)];

// ---- fable-budget fallback (operator directive 2026-07-27) ----
// The fable-weekly bucket (anthropic-ratelimit-unified-7d_oi) can run dry
// while the account still has general/opus budget. Before each attempt, a
// 1-token direct-API probe (~35 tok, ~1s) checks whether that (token, model)
// pair is currently accepted; a definite rejection (HTTP 429 or unified
// status "rejected") SKIPS the attempt instead of launching a CLI run that
// would stall retrying 429s. Probe errors (network etc.) count as allowed —
// never let a hiccup mask a healthy budget. Token reaches the probe child
// via env (not argv — keeps it out of `ps`).
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

// ---- erg ----
try {
  const extra = process.argv.slice(2).join(' ').trim();
  const prompt = '[erg ' + new Date().toISOString().slice(0, 16) + 'Z] Perform one erg.' + (extra ? '\n\n' + extra : '');
  const sysPrompt = buildSystemPrompt();
  // Attempt plan = every token on the preferred model, THEN every token on the
  // fallback model (the operator 2026-07-27: the fable weekly bucket can be dry while
  // the account still has opus budget). The model is deliberately NOT sticky:
  // every erg re-probes fable first, so we drift back to it for free the moment
  // its weekly bucket refills. Token stickiness (tok-pref.json) is unchanged.
  const PLAN = [];
  for (const m of [MODEL, FALLBACK_MODEL]) for (const s of SLOT_ORDER) PLAN.push({ slot: s, model: m });

  let r, res, ok = false, sid, t0, tokSlot = 1, model = MODEL, ran = false;
  const skipped = [];
  for (let attempt = 0; attempt < PLAN.length; attempt++) {
    tokSlot = PLAN[attempt].slot; model = PLAN[attempt].model;
    // cheap pre-flight (~35 tok): if THIS (token, model) pair is already being
    // rejected, skip it rather than launch a CLI run that stalls retrying 429s
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
      '--setting-sources', 'user',            // no project source → no CLAUDE.md
      '--disable-slash-commands',             // no skills
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--allowedTools', TOOLS, '--permission-mode', 'dontAsk',
      '--system-prompt', sysPrompt,
      '--session-id', sid];
    t0 = Date.now(); ran = true;
    log('erg begins ' + sid +
      (model !== MODEL ? ' [' + model + ' — fable budget dry]' : '') +
      (attempt ? ' (RETRY on token ' + tokSlot + ' after limit)'
               : (tokSlot !== 1 ? ' [token ' + tokSlot + ', remembered]' : '')) +
      (extra ? ' :: ' + extra.slice(0, 100).replace(/\n/g, ' ') : ''));
    r = spawnSync(CLAUDE, args, { cwd: HOME, env, encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024, timeout: TIMEOUT_MS });
    res = null; try { res = JSON.parse(r.stdout); } catch (_) {}
    ok = !!res && !res.is_error && r.status === 0;
    if (ok) break;
    const errTxt = (((res && res.result) || '') + ' ' + (r.stderr || '')).slice(0, 2000);
    if (attempt + 1 < PLAN.length && LIMIT_RE.test(errTxt)) {
      const nxt = PLAN[attempt + 1];
      log('LIMIT HIT on ' + model + '/token ' + tokSlot + ' — retrying whole erg on ' +
        nxt.model + '/token ' + nxt.slot +
        ' :: ' + errTxt.trim().slice(0, 200).replace(/\n/g, ' '));
      fs.appendFileSync(LEDGER, JSON.stringify({ sid, start: new Date(t0).toISOString(),
        ms: Date.now() - t0, ok: false, limitHit: true, tokSlot, model,
        extra: extra.slice(0, 120) || undefined }) + '\n');
      continue;
    }
    break;
  }
  if (!ran) { // every (token, model) pair pre-rejected — nothing was launched
    res = { result: 'no attempt made: all (token, model) pairs rejected by budget probe [' + skipped.join(', ') + ']' };
    ok = false; sid = sid || 'no-session'; t0 = t0 || Date.now();
  }
  // remember which slot succeeded → next erg starts there (sticky until IT limits out)
  if (ok && tokSlot !== prefSlot) log('token memory: next ergs start on token ' + tokSlot);
  if (ok) { try { fs.writeFileSync(PREF_FILE, JSON.stringify({ slot: tokSlot, at: new Date().toISOString() }) + '\n'); } catch (_) {} }
  // tokens: usage from the result json (in = fresh input, cached = cache reads+writes, out = generated)
  const u = res?.usage || null;
  const tok = u ? { in: (u.input_tokens || 0), cached: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: (u.output_tokens || 0) } : null;
  fs.appendFileSync(LEDGER, JSON.stringify({ sid, start: new Date(t0).toISOString(),
    ms: Date.now() - t0, cost: res?.total_cost_usd ?? null, turns: res?.num_turns ?? null,
    tok, ok, tokSlot: tokSlot > 1 ? tokSlot : undefined,
    model: model !== MODEL ? model : undefined,
    extra: extra.slice(0, 120) || undefined }) + '\n');
  // archive the erg: copy the full transcript (thinking, tool calls, all of it)
  if (ran) try {
    const tf = path.join(os.homedir(), '.claude', 'projects', HOME.replace(/[\/._]/g, '-'), sid + '.jsonl');
    if (fs.existsSync(tf)) {
      fs.mkdirSync(ERGS, { recursive: true });
      const name = new Date(t0).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z--' + sid + '.jsonl';
      fs.copyFileSync(tf, path.join(ERGS, name));
      log('archived → ergs/' + name);
    } else log('archive: transcript not found at ' + tf);
  } catch (e) { log('archive failed: ' + e.message); }
  log((ok ? 'erg done ' : 'ERG FAILED ') + sid +
    (tokSlot > 1 ? ' [token ' + tokSlot + ']' : '') +
    (model !== MODEL ? ' [' + model + ']' : '') +
    ' — took ' + fmtDur(Date.now() - t0) +
    ', cost ' + (res?.total_cost_usd != null ? '$' + res.total_cost_usd.toFixed(2) : '$?') +
    (res?.num_turns != null ? ' (' + res.num_turns + ' turns)' : '') +
    (tok ? ', tok ' + fmtTok(tok.in + tok.cached) + ' in (' + fmtTok(tok.cached) + ' cached) / ' + fmtTok(tok.out) + ' out' : '') +
    (ok ? '' : ' :: ' + ((res?.result || r.stderr || 'exit ' + r.status) + '').slice(0, 300)));
  if (ok && res.result) {
    const said = String(res.result).replace(/\n/g, ' | ');
    log('erg said: ' + (said.length > 1200 ? said.slice(0, 1200) + ' …[+' + (said.length - 1200) + ' chars cut]' : said));
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch (_) {}
}
