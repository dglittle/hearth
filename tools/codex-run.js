// codex-run — OpenAI runner for ergs (Astra / Sol) via `codex exec` (operator directive #4334, erg 1758).
//
// erg.js normally drives `claude -p`; this module is the drop-in for gpt-* picks from the
// board's ⚡ model dropdown. It spawns the vendored Codex CLI non-interactively, feeds the
// erg's system prompt + user prompt on STDIN (argv is capped at 128KiB), parses the --json
// event stream, and resolves to the SAME {status, stdout, stderr} shape runClaude() returns,
// with stdout = a JSON "res" object that finalize() already understands:
//   { result, total_cost_usd, usage{input_tokens,cache_read_input_tokens,
//     cache_creation_input_tokens,output_tokens}, num_turns, is_error, thread_id, runner:'codex' }
//
// Cost = API-EQUIVALENT (the operator's rule #3623: every robot's cost line is API-equiv, the ChatGPT
// sub pays $0): gpt-6-astra $10/$1/$50 · gpt-5.6-sol $5/$0.50/$30 per M (in / cached-in / out).
// Codex reports cached_input_tokens as a SUBSET of input_tokens (verified on the 0.153.4 probe).
//
// Session = codex "thread"; the id arrives in the first event (thread.started) → onThread(id) so
// erg.js can record it as the erg's sid; `resumeSid` replays the thread (`codex exec resume <id>`).
// Rollout file (for archiving): ~/.codex/sessions/Y/M/D/rollout-<ts>-<id>.jsonl → sessionFile(id).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const PRICES = {                                  // $/M tokens, API list
  'gpt-6-astra': { in: 10, cached: 1, out: 50 },
  'gpt-5.6-sol': { in: 5, cached: 0.5, out: 30 },
};
const isCodexModel = (m) => /^gpt-/.test(String(m || ''));
const priceOf = (m) => PRICES[m] || PRICES['gpt-6-astra'];

function runnerNote(model) {
  return '━━━ runner note — read first ━━━\n' +
    'You are {{AGENT_NAME}} running on OpenAI ' + model + ' through the Codex CLI (codex exec), NOT on Claude Code. ' +
    'Everything below this note is your standing system prompt, written for the Claude harness: where it names ' +
    'tools (Read/Grep/Glob/Edit/Write/Bash, run_in_background, Monitor, bg-wake) use your shell tool instead — ' +
    'there is no background-job wake on this runner, so run things in the foreground and keep the unit of work small. ' +
    'The card CLI, the covenants, the approval gate and the output-card contract apply unchanged. Do not ask for ' +
    'approvals or plans; do the work, finalize the output card, then end your turn.\n\n';
}

// Find the codex rollout jsonl for a thread id (null if not written yet / --ephemeral).
function sessionFile(id) {
  if (!id) return null;
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const stack = [root]; let best = null;
  while (stack.length) {
    const d = stack.pop(); let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('-' + id + '.jsonl') && e.name.startsWith('rollout-')) best = p;
    }
  }
  return best;
}

// Parse one --json event line into the accumulator.
function ingest(acc, line, hooks) {
  let o; try { o = JSON.parse(line); } catch (_) { return; }
  if (!o || typeof o.type !== 'string') return;
  if (o.type === 'thread.started' && o.thread_id) { acc.thread_id = o.thread_id; if (hooks.onThread) hooks.onThread(o.thread_id); }
  else if (o.type === 'item.completed' && o.item) {
    if (o.item.type === 'agent_message' && typeof o.item.text === 'string') acc.last = o.item.text;
    else if (o.item.type === 'command_execution') acc.turns++;
  }
  else if (o.type === 'turn.completed' && o.usage) {
    const u = o.usage;
    acc.in += u.input_tokens || 0; acc.cached += u.cached_input_tokens || 0;
    acc.cw += u.cache_write_input_tokens || 0; acc.out += u.output_tokens || 0;
  }
  else if (o.type === 'turn.failed' || o.type === 'error') {
    acc.err = (o.error && (o.error.message || String(o.error))) || o.message || o.type;
  }
}

function buildRes(acc, model, code) {
  const p = priceOf(model);
  const usd = ((acc.in - acc.cached) * p.in + acc.cached * p.cached + acc.out * p.out) / 1e6;
  return {
    result: acc.last || acc.err || '',
    total_cost_usd: Math.round(usd * 1e6) / 1e6,
    usage: { input_tokens: Math.max(0, acc.in - acc.cached), cache_read_input_tokens: acc.cached,
      cache_creation_input_tokens: acc.cw, output_tokens: acc.out },
    num_turns: acc.turns,
    is_error: !!acc.err || code !== 0,
    thread_id: acc.thread_id || null,
    runner: 'codex', model,
  };
}

// o = { bin, cwd, model, effort, sysPrompt, prompt, resumeSid, timeoutMs, env,
//       onChild(ch), onDone(), onThread(id) }
function run(o) {
  return new Promise((resolve) => {
    const effort = 'model_reasoning_effort=' + (o.effort || 'medium');
    const common = ['--json', '-m', o.model, '--skip-git-repo-check',
      '-c', effort, '-c', 'shell_environment_policy.inherit=all'];   // ERG_ID etc. must reach the shell (card CLI locks)
    // `codex exec resume` takes no -s/-C (verified 0.153.4) → sandbox via config override there
    const args = o.resumeSid
      ? ['exec', 'resume', ...common, '-c', 'sandbox_mode="danger-full-access"', o.resumeSid, '-']   // replay the thread, prompt on stdin
      : ['exec', ...common, '-s', 'danger-full-access', '-C', o.cwd, '-'];
    const promptText = (o.resumeSid ? '' : runnerNote(o.model) + (o.sysPrompt || '') + '\n\n━━━ this erg — prompt ━━━\n') + (o.prompt || '');
    let ch;
    try { ch = spawn(o.bin, args, { cwd: o.cwd, env: o.env || process.env, detached: true }); }
    catch (e) { return resolve({ status: -1, stdout: '', stderr: 'spawn threw: ' + e.message }); }
    if (o.onChild) o.onChild(ch);
    const acc = { in: 0, cached: 0, cw: 0, out: 0, turns: 0, last: '', err: '', thread_id: null };
    let buf = '', err = '';
    ch.stdin.on('error', () => {});
    ch.stdin.end(promptText);
    ch.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) ingest(acc, line, o); }
    });
    ch.stderr.on('data', (d) => { err += d; });
    const killer = setTimeout(() => {
      try { process.kill(-ch.pid, 'SIGKILL'); } catch (_) { try { ch.kill('SIGKILL'); } catch (_) {} }
      acc.err = acc.err || 'timeout after ' + Math.round((o.timeoutMs || 0) / 60000) + ' min';
    }, o.timeoutMs || 30 * 60000);
    const done = (code, extraErr) => {
      clearTimeout(killer); if (o.onDone) o.onDone();
      if (buf.trim()) ingest(acc, buf, o);
      // codex prints its usage-limit refusal on stderr, not as an event → surface it as the error
      if (!acc.err && code !== 0) acc.err = (err.trim().split('\n').filter((l) => /error|limit/i.test(l)).pop() || ('exit ' + code)).trim();
      if (extraErr) acc.err = acc.err || extraErr;
      const res = buildRes(acc, o.model, code == null ? -1 : code);
      resolve({ status: code == null ? -1 : code, stdout: JSON.stringify(res), stderr: err + (acc.err ? '\n' + acc.err : '') });
    };
    ch.on('close', (code) => done(code));
    ch.on('error', (e) => done(-1, String(e.message)));
  });
}

module.exports = { run, isCodexModel, sessionFile, PRICES, runnerNote, ingest, buildRes };

// CLI self-test:  node tools/codex-run.js [model] "prompt"   → prints the res JSON (costs ~nothing on the sub)
if (require.main === module) {
  const model = process.argv[2] || 'gpt-5.6-sol', prompt = process.argv[3] || 'Reply with exactly: OK';
  const bin = process.env.ERG_CODEX_BIN || path.join(__dirname, '..', 'vendor', 'codex-new', 'node_modules', '.bin', 'codex');
  run({ bin, cwd: path.join(__dirname, '..'), model, effort: 'low', sysPrompt: '(self-test: no system prompt)', prompt,
    timeoutMs: 120000, onThread: (id) => console.error('thread ' + id) })
    .then((r) => { console.log(r.stdout); if (r.status !== 0) console.error(r.stderr); process.exitCode = r.status === 0 ? 0 : 1; });
}
