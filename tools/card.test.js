#!/usr/bin/env node
// Smoke tests for tools/card.js against a throwaway db. Run: node tools/card.test.js
'use strict';
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w); });

const { execFileSync, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CARD = path.join(__dirname, 'card.js');
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cards-test-')), 'cards.db');
const baseEnv = { ...process.env, CARDS_DB: DB };
delete baseEnv.ERG_ID;

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ` — ${extra}` : '')); }
}
function run(args, env = {}) {
  return execFileSync(process.execPath, [CARD, ...args],
    { env: { ...baseEnv, ...env }, encoding: 'utf8' }).trim();
}
function runFail(args, env = {}) {  // returns {status, out} for expected failures
  const r = spawnSync(process.execPath, [CARD, ...args],
    { env: { ...baseEnv, ...env }, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
}

// 1. init
run(['init']);
ok(fs.existsSync(DB), 'init creates db file');

// 2. create + tips basics
ok(run(['create', '--kind', 'human', '--title', 'card A retail gating', '--status', 'ready',
  '--imp', '8', '--urg', '7']) === 'created #1', 'create human card (ready→draft) -> #1');
ok(run(['create', '--kind', 'work', '--title', 'draft card D']) === 'created #2',
  'create card via legacy kind alias -> #2');
let tips = run(['tips']);
ok(tips.includes('#1') && tips.includes('#2'), 'tips: both live cards listed (draft = live)', tips);
ok(tips.includes('[{{AGENT_NAME}}/'), 'legacy kind work aliased to {{AGENT_NAME}}', tips);
ok(tips.indexOf('#1') < tips.indexOf('#2'), 'higher imp·urg sorts first', tips);

// 3. live child removes parent from tips
run(['create', '--kind', 'work', '--title', 'card B child of A', '--status', 'ready', '--parent', '1']);
tips = run(['tips']);
ok(!tips.includes('#1 ') && tips.includes('#3'), 'live child #3 hides parent #1 from tips', tips);

// 4. archived child restores parent as tip
run(['status', '3', 'archived']);
tips = run(['tips']);
ok(tips.includes('#1 '), 'archiving child restores parent as tip', tips);

// 5. erg-kind child does NOT hide parent (in-flight info cards)
run(['create', '--kind', 'erg', '--title', '⚙ erg working', '--status', 'ready', '--parent', '1']);
ok(run(['tips']).includes('#1 '), 'erg-kind child does not hide parent');

// 6. lock: atomic acquisition + tips exclusion
run(['create', '--kind', 'output', '--title', 'card C ask', '--status', 'ready']);  // #5
const erg1 = run(['erg-start', '--mode', 'generic']);
ok(erg1 === '1', 'erg-start prints bare id 1', erg1);
ok(run(['lock', '1', '5'], { ERG_ID: erg1 }).includes('locked #1 #5'), 'lock 2 cards atomically');
tips = run(['tips']);
ok(!tips.includes('#1 ') && !tips.includes('#5 '), 'locked cards excluded from tips', tips);

// 7. lock conflict = exit 2, all-or-nothing (free card #2 must stay free)
const erg2 = run(['erg-start']);
run(['status', '2', 'ready']);
const conflict = runFail(['lock', '2', '1'], { ERG_ID: erg2 });
ok(conflict.status === 2, 'conflicting lock exits 2', String(conflict.status));
ok(conflict.out.includes('#1 by erg:1'), 'conflict names the holder', conflict.out);
ok(run(['tips']).includes('#2 '), 'all-or-nothing: free card #2 not locked by failed acquire');

// 8. lock with a missing id also refuses
ok(runFail(['lock', '2', '999'], { ERG_ID: erg2 }).status === 2, 'lock with missing id exits 2');

// 9. unlock-all releases everything this erg holds
ok(run(['unlock'], { ERG_ID: erg1 }).includes('unlocked 2'), 'unlock (no ids) releases both');

// 10. erg-end releases leftover locks
run(['lock', '1'], { ERG_ID: erg2 });
ok(run(['erg-end', erg2, '--status', 'done', '--result', 'DONE: test']).includes('released 1 lock'),
  'erg-end releases leftover locks');

// 11. reap: dead pid
const dead = spawnSync('sh', ['-c', 'exit 0']);  // pid guaranteed dead
const erg3 = run(['erg-start', '--pid', String(dead.pid)]);
run(['lock', '1'], { ERG_ID: erg3 });
const reapOut = run(['reap']);
ok(reapOut.includes('reaped lock on #1'), 'reap clears dead-pid lock', reapOut);
{
  const db = new DatabaseSync(DB);
  const e = db.prepare('SELECT status FROM ergs WHERE id = ?').get(Number(erg3));
  ok(e.status === 'failed', 'reaped erg marked failed', e.status);
  db.close();
}

// 12. reap: stale lock_at (alive pid, backdated) — reaped quietly by tips
const erg4 = run(['erg-start']);  // pid = this process, alive
run(['lock', '1'], { ERG_ID: erg4 });
{
  const db = new DatabaseSync(DB);
  db.prepare('UPDATE cards SET lock_at = ? WHERE id = 1').run('2020-01-01T00:00:00Z');
  db.close();
}
ok(run(['tips']).includes('#1 '), 'stale lock reaped on tips read');

// 13. edit + show + search
run(['edit', '1', '--title', 'card A retitled', '--body', 'needle-xyzzy body']);
const show = run(['show', '1']);
ok(show.includes('card A retitled') && show.includes('needle-xyzzy'), 'edit + show roundtrip');
ok(run(['search', 'needle-XYZZY']).includes('#1'), 'search case-insensitive regex over body');
ok(run(['search', 'no-such-thing-9q9q']) === '(no matches)', 'search misses cleanly');

// 14. show walks parent chain + marks refs
run(['create', '--kind', 'work', '--title', 'grandchild', '--status', 'ready', '--parent', '3', '--ref', '5']);  // #6
const show6 = run(['show', '6']);
ok(show6.includes('^ #3') && show6.includes('^^ #1'), 'show walks parent chain 2 deep', show6);
ok(show6.includes('~ref~ #5'), 'show lists ref parents', show6);

// 15. link/unlink
ok(run(['link', '5', '2', '--kind', 'ref']).includes('linked'), 'link ref');
ok(runFail(['link', '5', '2']).status === 1, 'duplicate link refused');
ok(run(['unlink', '5', '2']).includes('unlinked'), 'unlink');
ok(runFail(['link', '5', '5']).status === 1, 'self-link refused');

// 16. bad inputs die cleanly
ok(runFail(['create', '--kind', 'bogus', '--title', 'x']).status === 1, 'bad kind refused');
ok(runFail(['status', '1', 'bogus']).status === 1, 'bad status refused');
ok(runFail(['show', '999']).status === 1, 'show missing card errors');
ok(runFail(['lock', '1']).status === 1, 'lock without ERG_ID/--erg errors');

console.log(`\n${passed} passed, ${failed} failed  (db: ${DB})`);
fs.rmSync(path.dirname(DB), { recursive: true, force: true });
process.exit(failed ? 1 : 0);
