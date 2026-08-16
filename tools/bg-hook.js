#!/usr/bin/env node
// bg-hook.js — PreToolUse hook on Bash: fulfills the run_in_background
// contract under claude -p (design card #1608, built erg 589).
//
// Problem: claude -p exits at end of turn, killing background shells — the
// Bash tool doc's promise ("re-invokes you when it exits") is false here.
// Fix, piece 1 (this hook): rewrite any run_in_background command so the REAL
// job runs setsid-detached (survives claude exit) writing to
//   tmp/bg/<session_id>/<n>.{cmd,log,pid,exit}
// while the shell claude tracks becomes `tail --pid` on the log — so
// in-session BashOutput still streams and the tracked task "completes" when
// the real job exits. Piece 2 (erg.js BG_WAIT dial): after claude exits,
// wait on the markers and ♨-resume the session with a wake prompt.
//
// Guard: no-ops (empty output = unmodified input) unless ERG_BG=1 in env,
// so stray claude runs on this box are untouched. Fails open on any error.
'use strict';
const fs = require('fs'), path = require('path');
const HOME = path.dirname(__dirname);   // tools/.. = the {{AGENT_NAME}} home

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    if (process.env.ERG_BG !== '1') return;
    const h = JSON.parse(input);
    if (h.tool_name !== 'Bash' || !h.tool_input || !h.tool_input.run_in_background) return;
    const cmd = String(h.tool_input.command || '');
    if (!cmd.trim()) return;

    const sid = String(h.session_id || 'nosid').replace(/[^a-zA-Z0-9-]/g, '');
    const dir = path.join(HOME, 'tmp', 'bg', sid);
    fs.mkdirSync(dir, { recursive: true });
    const n = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const p = (ext) => path.join(dir, n + '.' + ext);

    // job wrapper: self-reports its pid (setsid may fork, so $! upstream can
    // be a dead intermediate — found erg 589), all output → .log, exit code
    // → .exit (the completion marker)
    fs.writeFileSync(p('cmd'),
      '#!/bin/bash\n' +
      'echo $$ > ' + JSON.stringify(p('pid')) + '\n' +
      'exec > ' + JSON.stringify(p('log')) + ' 2>&1\n' +
      '(\n' + cmd + '\n)\n' +
      'echo $? > ' + JSON.stringify(p('exit')) + '\n');
    fs.writeFileSync(p('log'), '');
    fs.appendFileSync(path.join(dir, 'manifest.jsonl'),
      JSON.stringify({ n, cmd: cmd.slice(0, 500), at: new Date().toISOString() }) + '\n');

    // what claude actually runs: detach the job, tail-stream its log, poll
    // the self-reported pid until the job dies, then exit with its code →
    // claude sees the task complete. Two traps found erg 589: (a) `tail
    // --pid` never fires if the dead job is an unreaped zombie (kill(pid,0)
    // still succeeds); (b) `wait $!` breaks when setsid forks (job-control
    // shells make bg jobs group leaders → $! is a dead intermediate). Hence:
    // shell stays alive (reaps its own children) + kill -0 poll on the pid
    // the wrapper itself reported.
    const watcher =
      'setsid bash ' + JSON.stringify(p('cmd')) + ' </dev/null >/dev/null 2>&1 & ' +
      'tail -n +1 -f ' + JSON.stringify(p('log')) + ' & TPID=$!; ' +
      'for i in $(seq 1 100); do [ -s ' + JSON.stringify(p('pid')) + ' ] && break; sleep 0.2; done; ' +
      'BGPID=$(cat ' + JSON.stringify(p('pid')) + ' 2>/dev/null); ' +
      'while [ -n "$BGPID" ] && kill -0 $BGPID 2>/dev/null; do sleep 2; done; ' +
      'kill $TPID 2>/dev/null; wait $TPID 2>/dev/null; ' +
      'exit $(cat ' + JSON.stringify(p('exit')) + ' 2>/dev/null || echo 143)';

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'bg-contract: job detached to tmp/bg/' + sid + '/' + n + '.*',
        updatedInput: { ...h.tool_input, command: watcher }
      }
    }));
  } catch (_) { /* fail open: no output = input passes through unmodified */ }
});
