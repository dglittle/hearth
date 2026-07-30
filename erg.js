#!/usr/bin/env node
// erg.js — {{AGENT_NAME}} performs one erg (one unit of work) against the card-board.
//
// Card-board edition, §5b model (design: work/card-board/design.md §5 + §5b).
// Continuity lives in db/cards.db; each erg is a fresh, bare-bones `claude -p`
// session — no CLAUDE.md, no skills, no auto-memory.
//
// erg↔card model (operator directive 2026-07-28 12:47Z + 13:01Z):
//   - Every erg is fired ON one or more parent cards (`--card N [--card M …]`).
//     There is NO generic no-target mode.
//   - erg.js locks all parent cards atomically (exit 2 if another erg holds
//     any), then creates ONE output card as child of ALL parents, and tells
//     the session "card #K is yours". No separate in-flight info card — the
//     output card IS the live indicator.
//   - Progress mirroring = the session directly edits its own card
//     (`card edit`); erg.js does no log polling. The session may also create
//     additional cards mid-flight.
//   - On exit erg.js appends a cost line (wall · model · tokens · usd) to the
//     card body, finalizes title/status only if the session left the
//     placeholder, releases locks. costs row + ergs.jsonl kept as silent
//     ledger; transcript jsonl copied to the ergs/ FOLDER (never sqlite).
//
// Usage: node erg.js --card N [--card M ...] ["optional extra context"]
// Env: CARDS_DB overrides db path (tests); ERG_CLAUDE_BIN overrides the
//   claude binary AND skips the budget probe (test mode).
// Log: erg.log (harness lines only)   Ledger: ergs.jsonl (+ costs table)

'use strict';
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w); });

const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const HOME = __dirname;
const DB_PATH = process.env.CARDS_DB || path.join(HOME, 'db', 'cards.db');
const CARD_CLI = path.join(HOME, 'tools', 'card.js');
const ERGS_DIR = path.join(HOME, 'ergs');
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

const CLAUDE = process.env.ERG_CLAUDE_BIN || CONF.CLAUDE_BIN || 'claude';
const TEST_MODE = !!process.env.ERG_CLAUDE_BIN;   // stub binary → skip budget probes
const MODEL = 'claude-fable-5';
const FALLBACK_MODEL = 'claude-opus-5'; // when fable weekly budget is dry (the operator 2026-07-27)
const TOOLS = 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,TodoWrite';
const TIMEOUT_MS = 30 * 60_000;

const log = (m) => { const l = new Date().toISOString() + ' [' + process.pid + '] ' + m; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's'; };
const fmtTok = (n) => n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'k' : (n / 1e6).toFixed(2) + 'M';
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ---- args: one or more --card N (parents; REQUIRED), rest = extra context ----
const parents = []; const restArgs = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--card') {
    const n = parseInt(process.argv[++i], 10);
    if (!Number.isInteger(n)) { console.error('erg.js: --card needs an integer'); process.exit(1); }
    parents.push(n);
  } else restArgs.push(process.argv[i]);
}
if (!parents.length) {
  console.error('erg.js: at least one --card N is required (generic ergs are gone — §5b).');
  console.error('usage: node erg.js --card N [--card M ...] ["extra context"]');
  process.exit(1);
}
const extra = restArgs.join(' ').trim();

// ---- db (direct handle for reads + finalize writes; CLI for lifecycle) ----
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');

function cardCli(args) {
  const r = spawnSync(process.execPath, [CARD_CLI, ...args], {
    cwd: HOME, env: { ...process.env, CARDS_DB: DB_PATH }, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// 1. reap stale locks (dead-pid / >60min) before anything else
{ const r = cardCli(['reap']); if (r.status !== 0) log('reap failed: ' + r.err); }

// 2. verify the parent cards exist
for (const p of parents) {
  const row = db.prepare('SELECT id FROM cards WHERE id = ?').get(p);
  if (!row) { console.error('erg.js: card #' + p + ' not found'); process.exit(1); }
}

// 3. register the erg (pid = this process, for liveness-based reaping)
const startRes = cardCli(['erg-start', '--mode', 'targeted', '--target', String(parents[0]), '--pid', String(process.pid)]);
const ERG = parseInt(startRes.out, 10);
if (!Number.isInteger(ERG)) { console.error('erg.js: erg-start failed: ' + startRes.err); process.exit(1); }

// 4. lock ALL parents atomically (all-or-nothing; exit 2 = another erg holds one)
{
  const r = cardCli(['lock', ...parents.map(String), '--erg', String(ERG)]);
  if (r.status !== 0) {
    cardCli(['erg-end', String(ERG), '--status', 'failed', '--result',
      'lock refused on card(s) ' + parents.join(',') + ' — another erg holds one']);
    log('ERG #' + ERG + ' ABORTED — lock conflict on card(s) ' + parents.join(','));
    process.exit(2);
  }
}

// 5. the ONE output card (§5b): child of ALL parents, live indicator while running
let outCard = null;
{
  const args = ['create', '--kind', '{{AGENT_NAME}}', '--status', 'draft',
    '--title', '⚙ erg #' + ERG + ' working on #' + parents.join(',#') + ' …',
    '--by', 'erg:' + ERG];
  for (const p of parents) args.push('--parent', String(p));
  const r = cardCli(args);
  const m = r.out.match(/created #(\d+)/);
  if (m) {
    outCard = parseInt(m[1], 10);
    db.prepare('UPDATE ergs SET info_card = ? WHERE id = ?').run(outCard, ERG);
  } else {
    cardCli(['erg-end', String(ERG), '--status', 'failed', '--result', 'output card create failed']);
    console.error('erg.js: output card create failed: ' + (r.err || r.out));
    process.exit(1);
  }
}

// ---- system prompt: mind cards + ready-tips index + harness facts ----
function buildSystemPrompt() {
  const parts = [];
  const minds = db.prepare(
    `SELECT id, title, body FROM cards WHERE kind = 'mind' AND status != 'archived'
     ORDER BY COALESCE(x,0), COALESCE(y,0), id`).all();
  for (const c of minds)
    parts.push('━━━ mind card #' + c.id + ' — ' + c.title + ' ━━━\n' + String(c.body).trim());
  const tips = cardCli(['tips']).out;
  parts.push('━━━ tips — the wider board (context only; your work is your target cards) ━━━\n' +
    (tips || '(no tips)'));
  parts.push('━━━ this erg — harness facts ━━━\n' +
    'You are erg:' + ERG + '. ERG_ID=' + ERG + ' is set in your environment, so the card CLI ' +
    'attributes your locks and creations automatically.\n' +
    'Your parent card(s) #' + parents.join(', #') + ' are ALREADY LOCKED for you; locks release when you exit.\n' +
    'Card #' + outCard + ' is YOURS — your final output goes there:\n' +
    '  - While working, edit it to share progress (the operator watches the board live):\n' +
    '    `card edit ' + outCard + ' --title "⚙ erg #' + ERG + ': <what you are doing now>"`\n' +
    '  - Before exiting, finalize it: title = one-sentence result, body = the deliverable\n' +
    '    (markdown, self-contained, links included), plus `--imp N --urg N` (1-10).\n' +
    '  - You MAY create additional cards (e.g. split deliverables, new asks) with\n' +
    '    `card create` — link them sensibly (children of #' + outCard + ' or of other cards).\n' +
    '  - If the work is unfinished, say so at the end of the card body ("got this far,\n' +
    '    more to do: …") — the operator fires a continuation erg on your card to extend the chain.\n' +
    'Do NOT create files for output — the card IS the deliverable.\n' +
    'Card CLI: `' + process.execPath + ' tools/card.js <cmd>` (cwd is the home dir). Help:\n' +
    cardCli(['help']).out);
  return parts.join('\n\n');
}

// ---- auth: subscription oauth only; tok1 primary, tok2 fallback on limit ----
let envText = '';
try { if (CONF.OAUTH_ENV_FILE) envText = fs.readFileSync(CONF.OAUTH_ENV_FILE, 'utf8'); } catch (_) {}
const TOKS = [
  (envText.match(/^CLAUDE_CODE_OAUTH_TOKEN=(\S+)/m) || [, ''])[1] || process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
  (envText.match(/^CLAUDE_CODE_OAUTH_TOKEN_2=(\S+)/m) || [, ''])[1] || process.env.CLAUDE_CODE_OAUTH_TOKEN_2 || '',
].filter(Boolean);
const baseEnv = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  ERG_ID: String(ERG), CARDS_DB: DB_PATH };
delete baseEnv.ANTHROPIC_API_KEY;   // never bill cash by accident
const LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|out of.*(quota|usage)|exceeded.*limit|\b429\b/i;
// Sticky token memory (operator directive 2026-07-26): start on the slot that
// last succeeded; a successful fallback flips the memory.
const PREF_FILE = path.join(HOME, 'tok-pref.json');
let prefSlot = 1;
try {
  const p = JSON.parse(fs.readFileSync(PREF_FILE, 'utf8')).slot;
  if (Number.isInteger(p) && p >= 1 && p <= TOKS.length) prefSlot = p;
} catch (_) {}
const SLOT_ORDER = [prefSlot, ...TOKS.map((_, i) => i + 1).filter((s) => s !== prefSlot)];

// ---- fable-budget probe (operator directive 2026-07-27; see git history for detail) ----
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
  if (TEST_MODE) return true;       // stub binary — nothing real is spent
  try {
    const pr = spawnSync(process.execPath, ['-e', PROBE_SRC, model],
      { env: { ...process.env, PROBE_TOK: tok }, encoding: 'utf8', timeout: 25000 });
    const o = JSON.parse((pr.stdout || '').trim());
    if (o.http === 429 || o.status === 'rejected') return false;
  } catch (_) {}
  return true;
}

// ---- async claude run with hard timeout ----
function runClaude(args, env) {
  return new Promise((resolve) => {
    const ch = spawn(CLAUDE, args, { cwd: HOME, env });
    let out = '', err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => { try { ch.kill('SIGKILL'); } catch (_) {} }, TIMEOUT_MS);
    ch.on('close', (code) => { clearTimeout(killer); resolve({ status: code, stdout: out, stderr: err }); });
    ch.on('error', (e) => { clearTimeout(killer); resolve({ status: -1, stdout: out, stderr: String(e.message) }); });
  });
}

// ------------------------------------------------------------------- main ---
(async () => {
  const promptTs = '[erg ' + new Date().toISOString().slice(0, 16) + 'Z] ';
  let prompt = promptTs + 'Perform one erg on card' + (parents.length > 1 ? 's' : '') +
    ' #' + parents.join(', #') + '. Your output card is #' + outCard + ' (see harness facts).';
  for (const p of parents) {
    const shown = cardCli(['show', String(p)]);
    prompt += '\n\n── target card #' + p + ' and its chain ──\n' + (shown.status === 0 ? shown.out : '(show failed: ' + shown.err + ')');
  }
  if (extra) prompt += '\n\n' + extra;
  const sysPrompt = buildSystemPrompt();

  // Attempt plan: every token on the preferred model, then on the fallback
  // (the fable weekly bucket can be dry while opus budget remains). Model is
  // deliberately NOT sticky; token slot is (tok-pref.json).
  const PLAN = [];
  for (const m of [MODEL, FALLBACK_MODEL]) for (const s of SLOT_ORDER) PLAN.push({ slot: s, model: m });
  if (!PLAN.length) PLAN.push({ slot: 1, model: MODEL });   // no tokens configured — rely on ambient auth

  let r, res, ok = false, sid, t0 = Date.now(), tokSlot = 1, model = MODEL, ran = false;
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
      '--setting-sources', 'user',            // no project source → no CLAUDE.md
      '--disable-slash-commands',             // no skills
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--allowedTools', TOOLS, '--permission-mode', 'dontAsk',
      '--system-prompt', sysPrompt,
      '--session-id', sid];
    t0 = Date.now(); ran = true;
    log('erg #' + ERG + ' begins ' + sid + ' [cards #' + parents.join(',#') + ' → out #' + outCard + ']' +
      (model !== MODEL ? ' [' + model + ' — fable budget dry]' : '') +
      (attempt ? ' (RETRY on token ' + tokSlot + ' after limit)'
               : (tokSlot !== 1 ? ' [token ' + tokSlot + ', remembered]' : '')) +
      (extra ? ' :: ' + extra.slice(0, 100).replace(/\n/g, ' ') : ''));
    r = await runClaude(args, env);
    res = null; try { res = JSON.parse(r.stdout); } catch (_) {}
    ok = !!res && !res.is_error && r.status === 0;
    if (ok) break;
    const errTxt = (((res && res.result) || '') + ' ' + (r.stderr || '')).slice(0, 2000);
    if (attempt + 1 < PLAN.length && LIMIT_RE.test(errTxt)) {
      const nxt = PLAN[attempt + 1];
      log('LIMIT HIT on ' + model + '/token ' + tokSlot + ' — retrying whole erg on ' +
        nxt.model + '/token ' + nxt.slot +
        ' :: ' + errTxt.trim().slice(0, 200).replace(/\n/g, ' '));
      fs.appendFileSync(LEDGER, JSON.stringify({ erg: ERG, sid, start: new Date(t0).toISOString(),
        ms: Date.now() - t0, ok: false, limitHit: true, tokSlot, model,
        extra: extra.slice(0, 120) || undefined }) + '\n');
      continue;
    }
    break;
  }
  if (!ran) {
    res = { result: 'no attempt made: all (token, model) pairs rejected by budget probe [' + skipped.join(', ') + ']' };
    ok = false; sid = sid || 'no-session';
  }
  // sticky token memory
  if (ok && tokSlot !== prefSlot) log('token memory: next ergs start on token ' + tokSlot);
  if (ok) { try { fs.writeFileSync(PREF_FILE, JSON.stringify({ slot: tokSlot, at: new Date().toISOString() }) + '\n'); } catch (_) {} }
  await finalize(ok, res, r, t0, ran, sid, tokSlot, model);
  process.exitCode = ok ? 0 : 1;
})();

// ---- finalize: costs row, erg row + lock release, output card, transcript ----
async function finalize(ok, res, r, t0, ran, sid, tokSlot = 1, model = MODEL) {
  const u = (res && res.usage) || null;
  const tok = u ? { in: (u.input_tokens || 0), cached: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: (u.output_tokens || 0) } : null;
  const usd = (res && res.total_cost_usd) != null ? res.total_cost_usd : null;
  const resultLine = String((res && res.result) || (r && r.stderr) || 'no output')
    .replace(/\n/g, ' ').slice(0, 300);

  // costs table (the claude-p cost log — silent ledger, no UI panel)
  if (ran) try {
    db.prepare(`INSERT OR REPLACE INTO costs(erg_id,wall_seconds,model,input_tokens,output_tokens,cache_read,cache_write,usd)
                VALUES(?,?,?,?,?,?,?,?)`).run(
      ERG, (Date.now() - t0) / 1000, model,
      u ? (u.input_tokens || 0) : null, u ? (u.output_tokens || 0) : null,
      u ? (u.cache_read_input_tokens || 0) : null, u ? (u.cache_creation_input_tokens || 0) : null, usd);
  } catch (e) { log('costs write failed: ' + e.message); }

  // erg row → done/failed + release every lock this erg still holds
  { const er = cardCli(['erg-end', String(ERG), '--status', ok ? 'done' : 'failed', '--result', resultLine]);
    if (er.status !== 0) log('erg-end failed: ' + er.err); }

  // the output card (§5b): if no session ever launched, delete it; else
  // finalize title/status ONLY where the session left the placeholder, and
  // append the cost line to the body.
  if (outCard != null) try {
    if (!ran) db.prepare('DELETE FROM cards WHERE id = ?').run(outCard);
    else {
      const c = db.prepare('SELECT title, body, status FROM cards WHERE id = ?').get(outCard);
      if (c) {
        const placeholder = c.title.startsWith('⚙ erg #' + ERG);
        const title = placeholder
          ? ((ok ? '✅' : '✗') + ' erg #' + ERG + ': ' + resultLine).slice(0, 200)
          : (ok ? c.title : ('✗ ' + c.title).slice(0, 200));
        const status = c.status;   // 'ready' retired 2026-07-28: 'draft' IS the live status, no flip needed
        const costLine = '\n\n⏱ ' + fmtDur(Date.now() - t0) + ' · ' + model +
          (tok ? ' · ' + fmtTok(tok.in + tok.cached) + ' in (' + fmtTok(tok.cached) + ' cached) / ' + fmtTok(tok.out) + ' out' : '') +
          (usd != null ? ' · $' + usd.toFixed(2) : '');
        db.prepare('UPDATE cards SET title = ?, status = ?, body = ?, updated_at = ? WHERE id = ?')
          .run(title, status, String(c.body || '') + costLine, nowIso(), outCard);
      }
    }
  } catch (e) { log('output card finalize failed: ' + e.message); }

  // ledger (kept alongside the costs table)
  fs.appendFileSync(LEDGER, JSON.stringify({ erg: ERG, sid, start: new Date(t0).toISOString(),
    ms: Date.now() - t0, cost: usd,
    turns: (res && res.num_turns) != null ? res.num_turns : null,
    tok, ok, cards: parents, out: outCard,
    tokSlot: tokSlot > 1 ? tokSlot : undefined,
    model: model !== MODEL ? model : undefined,
    extra: extra.slice(0, 120) || undefined }) + '\n');

  // archive the erg: copy the full transcript into the ergs/ FOLDER
  if (ran && sid && sid !== 'no-session') try {
    const tf = path.join(os.homedir(), '.claude', 'projects', HOME.replace(/[\/._]/g, '-'), sid + '.jsonl');
    if (fs.existsSync(tf)) {
      fs.mkdirSync(ERGS_DIR, { recursive: true });
      const name = new Date(t0).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z--' + sid + '.jsonl';
      fs.copyFileSync(tf, path.join(ERGS_DIR, name));
      log('archived → ergs/' + name);
    } else log('archive: transcript not found at ' + tf);
  } catch (e) { log('archive failed: ' + e.message); }

  log((ok ? 'erg #' + ERG + ' done ' : 'ERG #' + ERG + ' FAILED ') + (sid || '') +
    (tokSlot > 1 ? ' [token ' + tokSlot + ']' : '') +
    (model !== MODEL ? ' [' + model + ']' : '') +
    ' — took ' + fmtDur(Date.now() - t0) +
    ', cost ' + (usd != null ? '$' + usd.toFixed(2) : '$?') +
    ((res && res.num_turns) != null ? ' (' + res.num_turns + ' turns)' : '') +
    (tok ? ', tok ' + fmtTok(tok.in + tok.cached) + ' in (' + fmtTok(tok.cached) + ' cached) / ' + fmtTok(tok.out) + ' out' : '') +
    (ok ? '' : ' :: ' + (((res && res.result) || (r && r.stderr) || 'exit ' + (r && r.status)) + '').slice(0, 300)));
  if (ok && res.result) {
    const said = String(res.result).replace(/\n/g, ' | ');
    log('erg said: ' + (said.length > 1200 ? said.slice(0, 1200) + ' …[+' + (said.length - 1200) + ' chars cut]' : said));
  }
}
