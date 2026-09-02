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

// 7. lock conflict = exit 4 (EXIT.LOCK), all-or-nothing (free card #2 must stay free)
const erg2 = run(['erg-start']);
run(['status', '2', 'ready']);
const conflict = runFail(['lock', '2', '1'], { ERG_ID: erg2 });
ok(conflict.status === 4, 'conflicting lock exits 4', String(conflict.status));
ok(conflict.out.includes('#1 by erg:1'), 'conflict names the holder', conflict.out);
ok(run(['tips']).includes('#2 '), 'all-or-nothing: free card #2 not locked by failed acquire');

// 8. lock with a missing id also refuses
ok(runFail(['lock', '2', '999'], { ERG_ID: erg2 }).status === 4, 'lock with missing id exits 4');

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

// 14b. branchy parent walk dedupes across levels (shortcut link: #7 -> {3,6}, 6 -> 3)
run(['create', '--kind', 'work', '--title', 'branchy child', '--status', 'ready',
  '--parent', '3', '--parent', '6']);  // #7 (note: #6's parent is also #3)
const show7 = run(['show', '7']);
ok((show7.match(/\^+ #3 /g) || []).length === 1,
  'shortcut parent #3 printed once, at nearest depth', show7);
ok(show7.includes('^^ #1') && !show7.includes('^^ #3'),
  'walk continues past dedupe to grandparent #1', show7);

// 15. link/unlink
ok(run(['link', '5', '2', '--kind', 'ref']).includes('linked'), 'link ref');
ok(runFail(['link', '5', '2']).status === 5, 'duplicate link refused (exit 5 policy)');
ok(run(['unlink', '5', '2']).includes('unlinked'), 'unlink');
ok(runFail(['link', '5', '5']).status === 5, 'self-link refused (exit 5 policy)');
ok(runFail(['unlink', '5', '2']).status === 3, 'unlink of absent link exits 3');

// 16. bad inputs die cleanly — one exit code per failure class
ok(runFail(['create', '--kind', 'bogus', '--title', 'x']).status === 2, 'bad kind = usage (exit 2)');
ok(runFail(['status', '1', 'bogus']).status === 2, 'bad status = usage (exit 2)');
ok(runFail(['edit', 'abc']).status === 2, 'non-integer id = usage (exit 2)');
ok(runFail(['bogus-cmd']).status === 2, 'unknown command = usage (exit 2)');
ok(runFail(['show', '999']).status === 3, 'show missing card = not found (exit 3)');
ok(runFail(['create', '--kind', 'human', '--title', 'x', '--parent', '999']).status === 3,
  'create with absent --parent = not found (exit 3)');
ok(runFail(['create', '--kind', 'memory', '--title', 'x', '--x', '10', '--y', '500']).status === 5,
  'mind-space card in the interface half = policy (exit 5)');
ok(runFail(['lock', '1']).status === 6, 'lock without ERG_ID/--erg = no erg identity (exit 6)');
{
  const r = runFail(['lock', '1', '--erg', '4242']);
  ok(r.status === 3 && !r.out.includes('    at '), 'lock with unregistered erg id = exit 3, no stack trace', r.out);
}
ok(runFail(['show', '999']).out.includes('hint:'), 'errors carry a hint line');

// 17. --json: exactly one JSON value on stdout, human text on stderr only
function runJson(args, env = {}) {
  const r = spawnSync(process.execPath, [CARD, ...args, '--json'],
    { env: { ...baseEnv, ...env }, encoding: 'utf8' });
  let parsed = null, single = false;
  try { parsed = JSON.parse(r.stdout); single = true; } catch { /* not one value */ }
  return { status: r.status, json: parsed, single, stderr: r.stderr };
}
{
  const c = runJson(['create', '--kind', 'human', '--title', 'json card', '--imp', '3', '--urg', '9']);
  ok(c.single && c.status === 0 && Number.isInteger(c.json.id), 'create --json → {id}', JSON.stringify(c.json));
  const s = runJson(['show', String(c.json.id)]);
  ok(s.single && s.json.card.title === 'json card' && s.json.card.importance === 3 && s.json.card.urgency === 9,
    'show --json → card with numeric imp/urg', JSON.stringify(s.json && s.json.card));
  ok(Array.isArray(s.json.parents) && Array.isArray(s.json.refs) && Array.isArray(s.json.children),
    'show --json carries parents/refs/children arrays');
  const s6 = runJson(['show', '6']);
  ok(s6.json.parents.some(p => p.id === 3 && p.depth === 1) && s6.json.parents.some(p => p.id === 1 && p.depth === 2)
    && s6.json.refs.some(r => r.id === 5), 'show --json parents carry depth, refs listed', JSON.stringify(s6.json.parents));
  const t = runJson(['tips']);
  ok(t.single && Array.isArray(t.json) && t.json.some(x => x.id === c.json.id), 'tips --json → array of cards');
  const q = runJson(['search', 'json card']);
  ok(q.single && Array.isArray(q.json) && q.json.length === 1, 'search --json → array of matches');
  const q0 = runJson(['search', 'no-such-thing-9q9q']);
  ok(q0.single && Array.isArray(q0.json) && q0.json.length === 0, 'search --json empty → []');
  const e = runJson(['show', '999']);
  ok(e.status === 3 && e.single && e.json.error === 'notfound' && e.json.code === 3 && e.json.hint,
    'error --json → {error,code,message,hint} on stdout, same exit code', JSON.stringify(e.json));
  run(['lock', '5'], { ERG_ID: erg2 });
  const l = runJson(['lock', '1', '5'], { ERG_ID: erg1 });
  ok(l.single && l.json.error === 'lock' && l.status === 4 && l.json.held.some(h => h.id === 5 && h.erg === Number(erg2)),
    'lock refusal --json lists held {id,erg}', JSON.stringify(l.json));
  run(['unlock'], { ERG_ID: erg2 });
  const ed = runJson(['edit', String(c.json.id), '--title', 't2', '--urg', '1']);
  ok(ed.single && ed.json.fields.join(',') === 'title,urgency', 'edit --json → {id,fields}', JSON.stringify(ed.json));
  const jf = runJson(['--json', 'reap']);  // flag position is free; doubled flag harmless
  ok(jf.single && Array.isArray(jf.json.reaped), 'reap --json → {reaped:[]} (flag anywhere)');
  const h = spawnSync(process.execPath, [CARD, 'help'], { env: baseEnv, encoding: 'utf8' }).stdout;
  ok(h.includes('exit codes:') && h.includes('--json'), 'help documents exit codes + --json');
}

console.log(`\n${passed} passed, ${failed} failed  (db: ${DB})`);
fs.rmSync(path.dirname(DB), { recursive: true, force: true });
process.exit(failed ? 1 : 0);
