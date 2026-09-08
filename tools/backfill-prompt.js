// backfill-prompt — fill the prompt-size columns on costs for historical ergs
// (operator directive 2026-09-06, card #3440). Idempotent: only rows with ctx IS NULL.
//   sys_chars/sys_parts  ← ergs/sys-<sid>.txt
//   prompt_chars/anc     ← the erg's own '[erg …] Perform one erg…' / '♨ RESUMED' user line
//   ctx                  ← assistant usage per requestId inside started_at..ended_at
// Transcript = the LARGEST ergs/*--<sid>.jsonl (copies are cumulative).
// Usage: node tools/backfill-prompt.js [--dry] [--limit N]
'use strict';
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
const HOME = path.join(__dirname, '..');
const ctxm = require('./ctx.js');
const dry = process.argv.includes('--dry');
const lim = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
const db = new DatabaseSync(path.join(HOME, 'db', 'cards.db'));
for (const col of ['sys_chars INTEGER', 'sys_parts TEXT', 'prompt_chars INTEGER', 'anc_chars INTEGER', 'ctx TEXT'])
  try { db.exec('ALTER TABLE costs ADD COLUMN ' + col); } catch (_) {}

// sid → largest transcript file
const bySid = new Map();
for (const f of fs.readdirSync(path.join(HOME, 'ergs'))) {
  const m = f.match(/--([0-9a-f-]{36})\.jsonl$/); if (!m) continue;
  const p = path.join(HOME, 'ergs', f), sz = fs.statSync(p).size;
  const cur = bySid.get(m[1]);
  if (!cur || sz > cur.sz) bySid.set(m[1], { p, sz });
}
const rows = db.prepare(
  `SELECT e.id, e.sid, e.started_at, e.ended_at FROM ergs e JOIN costs co ON co.erg_id = e.id
    WHERE e.sid IS NOT NULL AND co.ctx IS NULL ORDER BY e.id DESC`).all();
const upd = db.prepare('UPDATE costs SET sys_chars=?, sys_parts=?, prompt_chars=?, anc_chars=?, ctx=? WHERE erg_id=?');
let n = 0, done = 0, noTr = 0, noCalls = 0;
for (const e of rows) {
  if (n++ >= lim) break;
  const tr = bySid.get(e.sid);
  let sys = null, sp = null;
  try { const t = fs.readFileSync(path.join(HOME, 'ergs', 'sys-' + e.sid + '.txt'), 'utf8'); sys = t.length; sp = JSON.stringify(ctxm.sysParts(t)); } catch (_) {}
  if (!tr) { noTr++; if (sys != null && !dry) upd.run(sys, sp, null, null, null, e.id); continue; }
  const r = ctxm.ctxFromTranscript(tr.p, e.started_at, e.ended_at);
  // the erg's own fired prompt: first string user line in the window starting with '[erg '
  let user = null, anc = null;
  try {
    const from = Date.parse(e.started_at) - 1500, to = e.ended_at ? Date.parse(e.ended_at) + 1500 : Infinity;
    for (const line of fs.readFileSync(tr.p, 'utf8').split('\n')) {
      if (line.indexOf('"user"') < 0 || line.indexOf('[erg ') < 0) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (o.type !== 'user' || !o.message || typeof o.message.content !== 'string' || !o.message.content.startsWith('[erg ')) continue;
      const t = Date.parse(o.timestamp || '');
      if (!(t >= from && t <= to)) continue;
      const up = ctxm.userParts(o.message.content); user = up.chars; anc = up.anc; break;
    }
  } catch (_) {}
  const ctx = r && r.ctx.length ? JSON.stringify(r.ctx) : null;
  if (!ctx) noCalls++; else done++;
  if (dry) console.log(e.id, e.sid.slice(0, 8), 'sys', sys, 'user', user, 'anc', anc, 'calls', r ? r.ctx.length : '-', 'first', r && r.ctx[0]);
  else upd.run(sys, sp, user, anc, ctx, e.id);
}
console.log(`rows ${rows.length} · measured ${done} · no transcript ${noTr} · no calls in window ${noCalls}${dry ? ' (dry)' : ''}`);
