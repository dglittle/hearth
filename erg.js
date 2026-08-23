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
const TOOLS = 'Bash,BashOutput,KillShell,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,TodoWrite';
// BashOutput/KillShell added erg 589: bg-contract (card #1608) makes
// run_in_background real, so in-session monitoring tools must not be denied.
// Tools the harness advertises but that CANNOT work in an erg: dontAsk mode
// auto-denies anything outside TOOLS, and claude -p exits at end of turn so
// monitors/wakeups/crons/subagent orchestration have nothing to fire into.
// --disallowedTools strips them from the system prompt so the model never
// wastes a call on a guaranteed denial (Monitor denial, erg 384 / #1114).
const NO_TOOLS = 'Agent,Workflow,ReportFindings,ScheduleWakeup,ToolSearch,' +
  'Monitor,CronCreate,CronDelete,CronList,DesignSync,EnterWorktree,' +
  'ExitWorktree,NotebookEdit,PushNotification,RemoteTrigger,SendMessage,' +
  'TaskCreate,TaskGet,TaskList,TaskOutput,TaskStop,TaskUpdate';
const TIMEOUT_MS = 30 * 60_000;

// ---- run_in_background contract (card #1608, erg 589) ----
// BG_WAIT=1 in host.conf (or ERG_BG_WAIT=1 env for tests) arms two pieces:
// (1) tools/bg-hook.js injected via --settings rewrites background commands →
//     setsid-detached job + markers in tmp/bg/<sid>/, tail-watcher for claude;
// (2) after a clean claude exit, bgWaitLoop() below polls the markers and
//     ♨-resumes the session with a wake prompt when a job completes.
// Dials: BG_MAX_WAKES (default 5) · BG_MAX_WAIT_MIN (default 120).
const BG_WAIT = (process.env.ERG_BG_WAIT || CONF.BG_WAIT) === '1';
const BG_DIR = (s) => path.join(HOME, 'tmp', 'bg', s);
const BG_SETTINGS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash',
  hooks: [{ type: 'command', command: process.execPath + ' ' + path.join(HOME, 'tools', 'bg-hook.js'), timeout: 10 }] }] } });

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
try { db.exec('ALTER TABLE ergs ADD COLUMN sid TEXT'); } catch (_) {}  // migration (warm-resume, card #756)

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

// ---- warm-session resume (operator directive 2026-08-01, card #756) ----
// If THE parent card is a human reply hanging under an {{AGENT_NAME}} output card
// whose claude session ended <1h ago, this erg is a dialog turn: run
// `claude -p --resume <sid>` with the ORIGINAL system prompt (stored at
// ergs/sys-<sid>.txt) so the whole prior conversation is a prompt-cache read.
// The resumed session's mind/tips are stale by design (the operator: "that's fine");
// the prompt tells it to re-check the board for anything it needs fresh.
const RESUME_WINDOW_MS = 60 * 60_000;
const transcriptPath = (s) => path.join(os.homedir(), '.claude', 'projects', HOME.replace(/[\/._]/g, '-'), s + '.jsonl');
const sysPath = (s) => path.join(ERGS_DIR, 'sys-' + s + '.txt');
function findResume() {
  if (parents.length !== 1) return null;
  const p = db.prepare('SELECT id, kind FROM cards WHERE id = ?').get(parents[0]);
  if (!p || p.kind !== 'human') return null;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT e.id AS erg, e.sid, e.ended_at, c.id AS card, co.model FROM links l
         JOIN cards c ON c.id = l.parent AND c.kind = '{{AGENT_NAME}}'
         JOIN ergs e ON e.info_card = c.id AND e.status = 'done' AND e.sid IS NOT NULL
         LEFT JOIN costs co ON co.erg_id = e.id
       WHERE l.child = ? AND l.kind = 'child'
       ORDER BY e.ended_at DESC`).all(p.id);
  } catch (_) { return null; }
  for (const r of rows) {
    if (!r.ended_at || Date.now() - Date.parse(r.ended_at) > RESUME_WINDOW_MS) continue;
    if (!fs.existsSync(transcriptPath(r.sid))) continue;
    // sibling-race guard (erg #273, card #848): if another LIVE erg is already
    // resumed on this sid, two claude processes would append to one transcript
    // jsonl — fall through to a fresh erg instead.
    try { if (db.prepare(`SELECT 1 FROM ergs WHERE sid = ? AND status = 'running'`).get(r.sid)) continue; } catch (_) {}
    let sys = null;
    try { sys = fs.readFileSync(sysPath(r.sid), 'utf8'); } catch (_) { continue; }
    return { sid: r.sid, card: r.card, erg: r.erg, model: r.model || MODEL, sys };
  }
  return null;
}

// ---- full-ancestor context (operator directive 2026-08-23, card #1899) ----
// When web/settings.json has fullAncestors ≠ false (default ON — board gear ⚙
// toggles it), the fired prompt carries EVERY ancestor of the target card(s)
// with FULL BODIES — not just `card show`'s 3-level title-only walk. BFS
// upward over child links, deduped across parents/branches (diamond/cycle
// safe); nearest generation first. Applies to fresh ergs only — a ♨ resumed
// session already holds the chain in its transcript.
function boardSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'web', 'settings.json'), 'utf8')); }
  catch (_) { return {}; }
}
function ancestorDump(rootIds) {
  const seen = new Set(rootIds);
  let level = [...rootIds], depth = 0;
  const out = [];
  while (level.length && depth < 100) {
    depth++;
    const qs = level.map(() => '?').join(',');
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT DISTINCT c.id, c.kind, c.status, c.title, c.body, c.created_by, c.created_at
           FROM links l JOIN cards c ON c.id = l.parent
          WHERE l.child IN (${qs}) AND l.kind = 'child'
          ORDER BY c.id`).all(...level);
    } catch (_) { break; }
    const next = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id); next.push(r.id);
      out.push({ depth, ...r });
    }
    level = next;
  }
  if (!out.length) return '';
  let s = '\n\n── full ancestor context (every ancestor of the target card(s), bodies included; ' +
    'gear ⚙ on the board toggles this) ──';
  for (const a of out) {
    s += '\n\n' + '^'.repeat(a.depth) + ' #' + a.id + ' [' + a.kind + '/' + a.status + '] ' +
      (a.title || '(untitled)') + '\n  by ' + (a.created_by || '?') + ' at ' + (a.created_at || '?');
    const body = String(a.body || '').trim();
    if (body) s += '\n  ---\n' + body;
  }
  return s;
}

// ---- system prompt: mind cards + ready-tips index + harness facts ----
function buildSystemPrompt() {
  const parts = [];
  const minds = db.prepare(
    `SELECT id, title, body FROM cards WHERE kind = 'mind' AND status != 'archived'
     ORDER BY COALESCE(x,0), COALESCE(y,0), id`).all();
  for (const c of minds)
    parts.push('━━━ mind card #' + c.id + ' — ' + c.title + ' ━━━\n' + String(c.body).trim());
  // memories (operator directive 2026-08-02, card #780): ONE recursive kind. Only TOP-LEVEL
  // memories (no live memory parent) appear here, TITLE only; `card show <id>`
  // gives a memory's full body + its child-memory titles — walk titles to leaves.
  const mems = db.prepare(
    `SELECT c.id, c.title, c.importance, c.urgency FROM cards c
     WHERE c.kind = 'memory' AND c.status != 'archived'
       AND NOT EXISTS (
         SELECT 1 FROM links l JOIN cards p ON p.id = l.parent
         WHERE l.child = c.id AND l.kind = 'child'
           AND p.kind = 'memory' AND p.status != 'archived')
     ORDER BY COALESCE(c.importance,5) + COALESCE(c.urgency,5) DESC, c.id`).all();
  parts.push('━━━ memories — top-level titles only; `card show <id>` opens one (full body + child-memory titles; children are hidden here by design) ━━━\n' +
    (mems.map((m) => '#' + m.id +
      ((m.importance || m.urgency) ? ' i' + (m.importance ?? '-') + '·u' + (m.urgency ?? '-') : '') +
      ' ' + m.title).join('\n') || '(no memories)'));
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
let prefSlot = 1, slotWhy = '';
try {
  const p = JSON.parse(fs.readFileSync(PREF_FILE, 'utf8')).slot;
  if (Number.isInteger(p) && p >= 1 && p <= TOKS.length) { prefSlot = p; slotWhy = 'remembered'; }
} catch (_) {}
// f7d-aware choice (operator directive 2026-08-13, #1407): prefer the token whose fable
// weekly bucket (7d_oi) resets SOONEST, per the most recent limits sample
// (web/limits.json — the board probes it on every erg finish). Needs a valid
// reset for EVERY configured slot, else fall back to the sticky memory above.
// The usual (token, model) fallback chain below is unchanged.
try {
  const lim = JSON.parse(fs.readFileSync(path.join(HOME, 'web', 'limits.json'), 'utf8'));
  const resets = (lim.slots || [])
    .filter((s) => !s.error && s.slot >= 1 && s.slot <= TOKS.length &&
                   s.buckets && s.buckets['7d_oi'] && s.buckets['7d_oi'].reset)
    .map((s) => ({ slot: s.slot, reset: s.buckets['7d_oi'].reset }));
  if (TOKS.length > 1 && resets.length === TOKS.length) {
    resets.sort((a, b) => a.reset - b.reset);
    prefSlot = resets[0].slot;
    slotWhy = 'f7d resets soonest, ' + new Date(resets[0].reset).toISOString().slice(0, 16) + 'Z' +
      ' (sample ' + Math.round((Date.now() - lim.at) / 60000) + 'm old)';
  }
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

// ---- stop control (board ⛔ → server `erg-stop` → SIGTERM here) ----
// SIGTERM = clean stop: kill the claude child's WHOLE process group (TERM,
// KILL after 10s), skip retries, and let finalize() run normally — locks
// released, cost line and "⛔ stopped" recorded on the output card. Group
// kill + severing our pipe ends matters: claude's grandchildren inherit the
// stdout/stderr pipes, and 'close' won't fire while any holder lives (first
// version hung the full child runtime here — 5m at 01:07Z, 120s in the
// sandbox retest). SIGKILL from outside remains the dirty path (reaper).
let CHILD = null, STOPPED = false;
let RESUMED = false, SYS_USED = '';   // warm-resume state for finalize (card #756)
function killChildTree(sig) {
  if (!CHILD) return;
  try { process.kill(-CHILD.pid, sig); }         // whole group (claude is a group leader)
  catch (_) { try { CHILD.kill(sig); } catch (_) {} }
}
process.on('SIGTERM', () => {
  if (STOPPED) return;
  STOPPED = true;
  log('erg #' + ERG + ' SIGTERM received — stopping (board ⛔)');
  killChildTree('SIGTERM');
  setTimeout(() => {
    killChildTree('SIGKILL');
    // last resort: a grandchild that setsid'd can still hold the pipes open —
    // destroy our read ends so runClaude's 'close' fires and finalize() runs.
    if (CHILD) { try { CHILD.stdout.destroy(); } catch (_) {} try { CHILD.stderr.destroy(); } catch (_) {} }
  }, 10_000).unref();
});

// ---- async claude run with hard timeout ----
function runClaude(args, env) {
  return new Promise((resolve) => {
    const ch = spawn(CLAUDE, args, { cwd: HOME, env, detached: true });   // own group → stoppable as a tree
    CHILD = ch;
    let out = '', err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => {
      killChildTree('SIGKILL');
      setTimeout(() => { if (CHILD) { try { CHILD.stdout.destroy(); } catch (_) {} try { CHILD.stderr.destroy(); } catch (_) {} } }, 2000).unref();
    }, TIMEOUT_MS);
    ch.on('close', (code) => { CHILD = null; clearTimeout(killer); resolve({ status: code, stdout: out, stderr: err }); });
    ch.on('error', (e) => { CHILD = null; clearTimeout(killer); resolve({ status: -1, stdout: out, stderr: String(e.message) }); });
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
  if (boardSettings().fullAncestors !== false) prompt += ancestorDump(parents);
  if (extra) prompt += '\n\n' + extra;
  const sysPrompt = buildSystemPrompt();

  // warm-session resume candidate (card #756): dialog turn on a live session
  const resume = findResume();
  let resumePrompt = null;
  if (resume) {
    const shown = cardCli(['show', String(parents[0])]);
    resumePrompt = promptTs + '♨ RESUMED SESSION — you are the same session that produced output card #' +
      resume.card + ' (erg #' + resume.erg + '). the operator replied: card #' + parents[0] +
      ', a child of your #' + resume.card + ', and this continuation erg was fired on it.\n' +
      'Continuation harness facts:\n' +
      '- You are now erg:' + ERG + ' (ERG_ID is updated in your environment); parent card #' + parents[0] + ' is locked for you.\n' +
      '- Card #' + outCard + ' is your NEW output card — same rules as before: progress-edit its title while working, finalize title/body/--imp/--urg before exit.\n' +
      '- Your context predates this reply: mind cards, tips, and board state may have drifted — `card show`/`card search` anything you need fresh; trust the board over memory.\n\n' +
      '── the operator\'s reply — card #' + parents[0] + ' and its chain ──\n' +
      (shown.status === 0 ? shown.out : '(show failed: ' + shown.err + ')') +
      (extra ? '\n\n' + extra : '');
    log('erg #' + ERG + ' warm-resume candidate: session ' + resume.sid + ' of erg #' + resume.erg +
      ' (output card #' + resume.card + ', model ' + resume.model + ')');
  }

  // Attempt plan: resume attempts first (pinned to the session's original
  // model — a model switch would cold-miss the cache anyway), then the normal
  // fresh plan: every token on the preferred model, then on the fallback
  // (the fable weekly bucket can be dry while opus budget remains). Model is
  // deliberately NOT sticky; token slot is (tok-pref.json). A failed resume
  // attempt (any error, not just limits) falls through to a fresh session.
  const PLAN = [];
  if (resume) for (const s of SLOT_ORDER) PLAN.push({ slot: s, model: resume.model, resume: true });
  for (const m of [MODEL, FALLBACK_MODEL]) for (const s of SLOT_ORDER) PLAN.push({ slot: s, model: m });
  if (!PLAN.length) PLAN.push({ slot: 1, model: MODEL });   // no tokens configured — rely on ambient auth

  let r, res, ok = false, sid, t0 = Date.now(), tokSlot = 1, model = MODEL, ran = false;
  const skipped = [];
  for (let attempt = 0; attempt < PLAN.length; attempt++) {
    if (STOPPED) break;
    tokSlot = PLAN[attempt].slot; model = PLAN[attempt].model;
    const isResume = !!PLAN[attempt].resume;
    if (TOKS[tokSlot - 1] && !modelAllowed(TOKS[tokSlot - 1], model)) {
      skipped.push(model + '@tok' + tokSlot);
      log('budget probe: ' + model + ' rejected on token ' + tokSlot + ' — skipping');
      continue;
    }
    sid = isResume ? resume.sid : crypto.randomUUID();
    const env = { ...baseEnv };
    if (TOKS[tokSlot - 1]) env.CLAUDE_CODE_OAUTH_TOKEN = TOKS[tokSlot - 1];
    if (BG_WAIT) env.ERG_BG = '1';           // arms tools/bg-hook.js (card #1608)
    const args = ['-p', isResume ? resumePrompt : prompt, '--output-format', 'json',
      '--model', model,
      '--setting-sources', 'user',            // no project source → no CLAUDE.md
      '--disable-slash-commands',             // no skills
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--allowedTools', TOOLS, '--disallowedTools', NO_TOOLS, '--permission-mode', 'dontAsk',
      '--system-prompt', isResume ? resume.sys : sysPrompt,
      ...(BG_WAIT ? ['--settings', BG_SETTINGS] : []),
      ...(isResume ? ['--resume', resume.sid] : ['--session-id', sid])];
    t0 = Date.now(); ran = true;
    // record sid NOW (not just at finalize) so the board's /hud endpoint can
    // tail the live transcript while we run (HUD overlay — operator directive 2026-08-06, #988)
    try { db.prepare('UPDATE ergs SET sid = ? WHERE id = ?').run(sid, ERG); } catch (_) {}
    RESUMED = isResume; SYS_USED = isResume ? resume.sys : sysPrompt;
    log('erg #' + ERG + ' begins ' + sid + (isResume ? ' [♨ RESUME]' : '') +
      ' [cards #' + parents.join(',#') + ' → out #' + outCard + ']' +
      (model !== MODEL ? ' [' + model + (isResume ? ' — session model' : ' — fable budget dry') + ']' : '') +
      (attempt ? ' (RETRY on token ' + tokSlot + ')'
               : (slotWhy ? ' [token ' + tokSlot + ', ' + slotWhy + ']' : '')) +
      (extra ? ' :: ' + extra.slice(0, 100).replace(/\n/g, ' ') : ''));
    r = await runClaude(args, env);
    res = null; try { res = JSON.parse(r.stdout); } catch (_) {}
    ok = !!res && !res.is_error && r.status === 0;
    if (ok) break;
    if (STOPPED) { log('erg #' + ERG + ' stopped mid-run — no retry'); break; }
    const errTxt = (((res && res.result) || '') + ' ' + (r.stderr || '')).slice(0, 2000);
    if (attempt + 1 < PLAN.length && (LIMIT_RE.test(errTxt) || isResume)) {
      const nxt = PLAN[attempt + 1];
      log((isResume ? 'RESUME FAILED' : 'LIMIT HIT') + ' on ' + model + '/token ' + tokSlot +
        ' — retrying whole erg ' + (nxt.resume ? 'as resume' : 'fresh') + ' on ' +
        nxt.model + '/token ' + nxt.slot +
        ' :: ' + errTxt.trim().slice(0, 200).replace(/\n/g, ' '));
      fs.appendFileSync(LEDGER, JSON.stringify({ erg: ERG, sid, start: new Date(t0).toISOString(),
        ms: Date.now() - t0, ok: false, limitHit: true, tokSlot, model,
        resumed: isResume || undefined,
        extra: extra.slice(0, 120) || undefined }) + '\n');
      continue;
    }
    break;
  }
  if (!ran) {
    res = { result: 'no attempt made: all (token, model) pairs rejected by budget probe [' + skipped.join(', ') + ']' };
    ok = false; sid = sid || 'no-session';
  }
  // run_in_background contract, piece 2 (card #1608): claude exited cleanly
  // but detached bg jobs may still run — wait on their markers, then wake the
  // session. Fully try/caught: any failure falls through to normal finalize.
  if (ok && BG_WAIT && ran && !STOPPED) {
    try { ({ r, res } = await bgWaitLoop(sid, model, tokSlot, r, res)); }
    catch (e) { log('bg-wait failed (ignored): ' + e.message); }
  }

  // sticky token memory
  if (ok && tokSlot !== prefSlot) log('token memory: next ergs start on token ' + tokSlot);
  if (ok) { try { fs.writeFileSync(PREF_FILE, JSON.stringify({ slot: tokSlot, at: new Date().toISOString() }) + '\n'); } catch (_) {} }
  await finalize(ok, res, r, t0, ran, sid, tokSlot, model);
  process.exitCode = ok ? 0 : 1;
})();

// ---- run_in_background contract: marker scan + wait/wake loop (card #1608) ----
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
function bgJobs(sid) {   // pending jobs = have a .pid, not yet woken about
  const dir = BG_DIR(sid); let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.pid')); } catch (_) { return []; }
  return names.map((f) => {
    const n = f.slice(0, -4), p = (ext) => path.join(dir, n + '.' + ext);
    if (fs.existsSync(p('woke'))) return null;
    let pid = null, exit = null, cmd = '';
    try { pid = parseInt(fs.readFileSync(p('pid'), 'utf8'), 10); } catch (_) {}
    try { exit = fs.readFileSync(p('exit'), 'utf8').trim(); } catch (_) {}
    try { cmd = fs.readFileSync(p('cmd'), 'utf8').split('\n').slice(4, -3).join('\n'); } catch (_) {}
    return { n, pid, exit, cmd, log: p('log'), wokePath: p('woke'),
      done: exit !== null || !pid || !pidAlive(pid) };
  }).filter(Boolean);
}

async function bgWaitLoop(sid, model, tokSlot, r, res) {
  const MAXWAKES = parseInt(CONF.BG_MAX_WAKES || '5', 10);
  const MAXWAIT = parseInt(CONF.BG_MAX_WAIT_MIN || '120', 10) * 60000;
  const t0 = Date.now(); let wakes = 0;
  while (!STOPPED && wakes < MAXWAKES && Date.now() - t0 < MAXWAIT) {
    const jobs = bgJobs(sid);
    if (!jobs.length) break;
    const ready = jobs.filter((j) => j.done);
    if (!ready.length) {
      if ((Date.now() - t0) % 60000 < 10000)
        log('bg-wait: ' + jobs.length + ' job(s) still running (' + fmtDur(Date.now() - t0) + ' waited)');
      await new Promise((s) => setTimeout(s, 10000));
      continue;
    }
    for (const j of ready) try { fs.writeFileSync(j.wokePath, nowIso()); } catch (_) {}
    const remaining = jobs.length - ready.length;
    let wp = '[erg ' + new Date().toISOString().slice(0, 16) + 'Z] ⏰ BACKGROUND TASK' +
      (ready.length > 1 ? 'S' : '') + ' COMPLETED — the harness kept this erg alive and woke ' +
      'your session (run_in_background contract, card #1608). You are still erg:' + ERG +
      ' with output card #' + outCard + ' — fold the results in and finalize it as usual.' +
      (remaining ? ' ' + remaining + ' background job(s) still running — you will be woken again.'
                 : ' No other background jobs pending; new ones you start will also wake you.') + '\n';
    for (const j of ready) {
      let tail = ''; try { const b = fs.readFileSync(j.log, 'utf8'); tail = b.length > 4000 ? '…' + b.slice(-4000) : b; } catch (_) {}
      wp += '\n── job ' + j.n + ' — exit ' + (j.exit !== null ? j.exit : '? (process gone, no exit marker — possibly killed)') + '\n' +
        '- command: ' + j.cmd.trim().slice(0, 300).replace(/\n/g, ' ⏎ ') + '\n' +
        '- full log: ' + j.log + ' (the old in-session shell id is dead — Read this file instead)\n' +
        '- log tail:\n```\n' + tail + '\n```\n';
    }
    wakes++;
    log('bg-wake #' + wakes + ': ' + ready.length + ' job(s) done, ' + remaining + ' pending — resuming ' + sid);
    const env = { ...baseEnv, ERG_BG: '1' };
    if (TOKS[tokSlot - 1]) env.CLAUDE_CODE_OAUTH_TOKEN = TOKS[tokSlot - 1];
    const args = ['-p', wp, '--output-format', 'json', '--model', model,
      '--setting-sources', 'user', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--allowedTools', TOOLS, '--disallowedTools', NO_TOOLS, '--permission-mode', 'dontAsk',
      '--system-prompt', SYS_USED, '--settings', BG_SETTINGS, '--resume', sid];
    const r2 = await runClaude(args, env);
    let res2 = null; try { res2 = JSON.parse(r2.stdout); } catch (_) {}
    if (!res2 || res2.is_error || r2.status !== 0) {
      log('bg-wake resume FAILED (jobs stay on disk in ' + BG_DIR(sid) + '): ' +
        (((res2 && res2.result) || r2.stderr || 'exit ' + r2.status) + '').slice(0, 200));
      break;
    }
    // fold the wake turn's usage/cost into the erg's totals
    if (res2.total_cost_usd != null) res.total_cost_usd = (res.total_cost_usd || 0) + res2.total_cost_usd;
    if (res2.usage) {
      if (!res.usage) res.usage = {};
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
        res.usage[k] = (res.usage[k] || 0) + (res2.usage[k] || 0);
    }
    if (res2.num_turns != null) res.num_turns = (res.num_turns || 0) + res2.num_turns;
    if (res2.result) res.result = res2.result;
    r = r2;
  }
  if (wakes >= MAXWAKES) log('bg-wait: max wakes (' + MAXWAKES + ') reached — remaining jobs orphaned in ' + BG_DIR(sid));
  else if (Date.now() - t0 >= MAXWAIT) log('bg-wait: max wait reached — jobs still running orphaned in ' + BG_DIR(sid));
  return { r, res };
}

// ---- finalize: costs row, erg row + lock release, output card, transcript ----
async function finalize(ok, res, r, t0, ran, sid, tokSlot = 1, model = MODEL) {
  const u = (res && res.usage) || null;
  const tok = u ? { in: (u.input_tokens || 0), cached: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: (u.output_tokens || 0) } : null;
  const usd = (res && res.total_cost_usd) != null ? res.total_cost_usd : null;
  let resultLine = String((res && res.result) || (r && r.stderr) || 'no output')
    .replace(/\n/g, ' ').slice(0, 300);
  if (STOPPED && !ok) resultLine = '⛔ stopped from the board (SIGTERM)';

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

  // warm-resume bookkeeping (card #756): remember this erg's session id and
  // persist the exact system prompt, so an operator-reply child card can resume the
  // session (<1h) with an identical prompt prefix → whole-context cache read.
  if (ok && sid && sid !== 'no-session') try {
    db.prepare('UPDATE ergs SET sid = ? WHERE id = ?').run(sid, ERG);
    if (SYS_USED && !fs.existsSync(sysPath(sid))) {
      fs.mkdirSync(ERGS_DIR, { recursive: true });
      fs.writeFileSync(sysPath(sid), SYS_USED);
    }
  } catch (e) { log('warm-resume bookkeeping failed: ' + e.message); }

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
        const costLine = '\n\n⏱ ' + fmtDur(Date.now() - t0) + (RESUMED ? ' · ♨ resumed' : '') + ' · ' + model +
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
    resumed: RESUMED || undefined,
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
