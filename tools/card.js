#!/usr/bin/env node
// card — CLI over db/cards.db (node:sqlite, zero deps). Design: work/card-board/design.md §5.3.
// Sessions use this instead of raw SQL; every mutation is one short transaction.
//
// Env: CARDS_DB overrides db path (tests); ERG_ID = this erg's id (lock owner / created_by).
//
// Exit codes (one per failure CLASS, so scripts branch on $? not on stderr text — erg 1078,
// the deploy-CLI pattern: class-coded exits + a hint on every error):
//   0 ok · 1 unexpected (db/constraint) · 2 usage (bad/missing args, unknown cmd)
//   3 not found (card/link) · 4 lock conflict (all-or-nothing refused) · 5 policy
//   (quadrant rule, self-link, duplicate link) · 6 no erg identity (--erg/ERG_ID)
// --json (any position): exactly ONE JSON value on stdout (errors too: {error,code,message,hint});
// human text goes to stderr only. Without it, output is the terse text below.

'use strict';
// suppress the node:sqlite ExperimentalWarning (must be registered before require)
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w); });

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.CARDS_DB || path.join(__dirname, '..', 'db', 'cards.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');
const KINDS = ['mind', 'memory', 'human', '{{AGENT_NAME}}', 'erg', 'header', 'zone'];
// 'zone' (operator directive 2026-08-12, #1295): decorative colored rectangle behind cards —
// pure organization, no chain semantics; the board paints it under everything.
// two-kind interface (operator directive 2026-07-29, card #275): lower-right = human + {{AGENT_NAME}} only;
// old input/output/work kinds retired — aliases keep stray callers working.
// 'memory' replaces short-term/long-term (operator directive 2026-08-02, card #780): ONE
// recursive kind; top-level memory TITLES go in the system prompt, child
// memories are reached via `card show <parent>`.
const KIND_ALIAS = { input: 'human', output: '{{AGENT_NAME}}', work: '{{AGENT_NAME}}',
  'short-term': 'memory', 'long-term': 'memory' };
const STATUSES = ['draft', 'done', 'archived'];  // 'ready' retired 2026-07-28 (all ergs explicit); 'draft' = live
const normStatus = (s) => (s === 'ready' ? 'draft' : s);  // back-compat for stray callers
const STALE_LOCK_MIN = 60;

function now() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

function openDb() {
  const fresh = !fs.existsSync(DB_PATH);
  if (fresh) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
  if (fresh) db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  db.function('regexp', { deterministic: true }, (pat, text) => {
    if (text == null) return 0;
    try { return new RegExp(pat, 'i').test(String(text)) ? 1 : 0; } catch { return 0; }
  });
  return db;
}

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, NOTFOUND: 3, LOCK: 4, POLICY: 5, NOERG: 6 };
const EXIT_NAME = Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, k.toLowerCase()]));
const JSON_MODE = process.argv.slice(2).includes('--json');

// die(msg, code, hint?, extra?) — text: 'card: msg' (+ '  hint: …') on stderr;
// json: {error:<class>, code, message, hint?, ...extra} on stdout. Same exit code either way.
function die(msg, code = EXIT.ERROR, hint, extra) {
  console.error('card: ' + msg + (hint ? `\n  hint: ${hint}` : ''));
  if (JSON_MODE) console.log(JSON.stringify({ error: EXIT_NAME[code] || 'error', code, message: msg,
    ...(hint ? { hint } : {}), ...(extra || {}) }));
  process.exit(code);
}
// emit(payload, lines) — json: one JSON value; text: the given lines (string or array)
function emit(payload, lines) {
  if (JSON_MODE) return console.log(JSON.stringify(payload));
  for (const l of [].concat(lines)) console.log(l);
}

// --- tiny arg parser: positionals + --flag [value]; repeatable: --parent/--ref ---
function parseArgs(argv) {
  const pos = []; const flags = { parent: [], ref: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      if (k === 'parent' || k === 'ref') flags[k].push(intArg(v, '--' + k));
      else flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}
function intArg(v, name) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) die(`${name} needs an integer, got ${JSON.stringify(v)}`, EXIT.USAGE);
  return n;
}
function readBody(v) { return v === '-' ? fs.readFileSync(0, 'utf8') : String(v); }
function whoami(flags) {
  if (flags.by) return String(flags.by);
  if (process.env.ERG_ID) return 'erg:' + process.env.ERG_ID;
  return 'operator';
}
function ergId(flags) {
  const v = flags.erg !== undefined ? flags.erg : process.env.ERG_ID;
  if (v === undefined) die('need --erg <id> or ERG_ID env', EXIT.NOERG, 'inside an erg ERG_ID is exported; by hand pass --erg <id>');
  return intArg(v, '--erg/ERG_ID');
}

// --- output helpers (terse text — session-token-friendly) ---
function line(c) {
  const iu = (c.importance || c.urgency) ? ` i${c.importance ?? '-'}·u${c.urgency ?? '-'}` : '';
  const lk = c.lock_erg ? ` 🔒erg:${c.lock_erg}` : '';
  return `#${c.id} [${c.kind}/${c.status}]${iu}${lk} ${c.title}`;
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const TIPS_SQL = `
  SELECT c.* FROM cards c
  WHERE c.status = 'draft' AND c.lock_erg IS NULL
    AND c.kind IN ('human','{{AGENT_NAME}}')
    AND NOT EXISTS (
      SELECT 1 FROM links l JOIN cards ch ON ch.id = l.child
      WHERE l.parent = c.id AND l.kind = 'child'
        AND ch.kind != 'erg' AND ch.status != 'archived')
  ORDER BY COALESCE(c.importance,5) + COALESCE(c.urgency,5) DESC, c.updated_at ASC`;

/* interface area (the WHOLE lower half: y>0) is reserved for human/{{AGENT_NAME}}
   cards — the mind-card rule. Guard added erg 14 after short-term #57 was
   created with --x 400 --y 1930 and leaked into the operator's interface; widened
   from the lower-right quadrant to the lower half to match the board (the operator
   2026-08-05, #960 — board.html moved in 8b7bbe0, this guard lagged).
   header is exempt (labels go anywhere). Non-numeric/cleared coords pass. */
function guardQuadrant(kind, x, y) {
  if (kind === 'human' || kind === '{{AGENT_NAME}}' || kind === 'header' || kind === 'zone') return;  // zones decorate anywhere (#1295)
  const ny = Number(y);
  if (Number.isFinite(ny) && ny > 0)
    die(`a ${kind} card may not be placed in the interface half (y>0 is for human/{{AGENT_NAME}} cards)`, EXIT.POLICY,
      'omit coords or use --x none --y none for auto-placement');
}

function getCard(db, id) {
  const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!c) die(`no card #${id}`, EXIT.NOTFOUND, 'ids never recycle — the card was deleted or never existed; try: card search <title words>');
  return c;
}

// ---------------------------------------------------------------- commands ---
const commands = {

  init() { openDb(); emit({ db: DB_PATH }, 'db ready: ' + DB_PATH); },

  tips() {
    const db = openDb();
    reap(db);
    const rows = db.prepare(TIPS_SQL).all();
    emit(rows, rows.length ? rows.map(line) : '(no ready tips)');
  },

  show({ pos }) {
    const db = openDb();
    const id = intArg(pos[0], 'id');
    const c = getCard(db, id);
    const out = [line(c),
      `  by ${c.created_by} at ${c.created_at} · updated ${c.updated_at}` + (c.url ? `\n  url: ${c.url}` : '')];
    if (c.body) out.push('  ---\n' + String(c.body).replace(/^/gm, '  '));
    // parent chain, depth 3, 'child' links only; seen-set dedupes across
    // branches/levels (diamonds, shortcut links, cycles)
    const parents = [];  // {depth, ...card}
    let level = [id];
    const seen = new Set(level);
    for (let d = 1; d <= 3 && level.length; d++) {
      const qs = level.map(() => '?').join(',');
      const found = db.prepare(
        `SELECT DISTINCT p.* FROM links l JOIN cards p ON p.id = l.parent
         WHERE l.child IN (${qs}) AND l.kind = 'child'`).all(...level)
        .filter(p => !seen.has(p.id));
      for (const p of found) { seen.add(p.id); parents.push({ depth: d, ...p }); out.push(`  ${'^'.repeat(d)} ${line(p)}`); }
      level = found.map(p => p.id);
    }
    const refs = db.prepare(
      `SELECT p.* FROM links l JOIN cards p ON p.id = l.parent
       WHERE l.child = ? AND l.kind = 'ref'`).all(id);
    for (const r of refs) out.push(`  ~ref~ ${line(r)}`);
    const kids = db.prepare(
      `SELECT ch.*, l.kind AS link FROM links l JOIN cards ch ON ch.id = l.child
       WHERE l.parent = ?`).all(id);
    for (const k of kids) out.push(`  ${k.link === 'ref' ? '~>' : '->'} ${line(k)}`);
    emit({ card: c, parents, refs, children: kids }, out);
  },

  create({ flags }) {
    const db = openDb();
    let kind = String(flags.kind || '');
    kind = KIND_ALIAS[kind] || kind;
    if (!KINDS.includes(kind)) die(`--kind must be one of: ${KINDS.join(' ')}`, EXIT.USAGE);
    guardQuadrant(kind, flags.x, flags.y);
    const title = (flags.title === undefined || flags.title === true) ? '' : String(flags.title);
    const status = flags.status ? normStatus(String(flags.status)) : 'draft';
    if (!STATUSES.includes(status)) die(`--status must be one of: ${STATUSES.join(' ')}`, EXIT.USAGE);
    const t = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = db.prepare(
        `INSERT INTO cards(kind,title,body,status,x,y,importance,urgency,url,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        kind, title, flags.body !== undefined ? readBody(flags.body) : '',
        status,
        flags.x !== undefined ? Number(flags.x) : null,
        flags.y !== undefined ? Number(flags.y) : null,
        flags.imp !== undefined ? intArg(flags.imp, '--imp') : null,
        flags.urg !== undefined ? intArg(flags.urg, '--urg') : null,
        flags.url !== undefined ? String(flags.url) : null,
        whoami(flags), t, t);
      const id = Number(r.lastInsertRowid);
      const link = db.prepare('INSERT INTO links(parent,child,kind) VALUES(?,?,?)');
      for (const p of flags.parent) link.run(p, id, 'child');
      for (const p of flags.ref) link.run(p, id, 'ref');
      db.exec('COMMIT');
      emit({ id }, `created #${id}`);
    } catch (e) { db.exec('ROLLBACK'); die(e.message, /FOREIGN KEY/.test(e.message) ? EXIT.NOTFOUND : EXIT.ERROR,
      /FOREIGN KEY/.test(e.message) ? 'a --parent/--ref id does not exist' : undefined); }
  },

  edit({ pos, flags }) {
    const db = openDb();
    const id = intArg(pos[0], 'id');
    const cur = getCard(db, id);
    if (flags.x !== undefined || flags.y !== undefined)
      guardQuadrant(cur.kind,
        flags.x !== undefined ? flags.x : cur.x,
        flags.y !== undefined ? flags.y : cur.y);
    const sets = [], vals = [];
    if (flags.title !== undefined) { sets.push('title = ?'); vals.push(String(flags.title)); }
    if (flags.body !== undefined) { sets.push('body = ?'); vals.push(readBody(flags.body)); }
    if (flags.url !== undefined) { sets.push('url = ?'); vals.push(String(flags.url)); }
    if (flags.imp !== undefined) { sets.push('importance = ?'); vals.push(intArg(flags.imp, '--imp')); }
    if (flags.urg !== undefined) { sets.push('urgency = ?'); vals.push(intArg(flags.urg, '--urg')); }
    // '--x none' / '--y none' (or 'null') clears the coord → board re-places the
    // card by its kind-quadrant fallback (added erg 14 after #57 leaked into the interface)
    const coord = (v, name) => (v === 'none' || v === 'null') ? null : intArg(v, name);
    if (flags.x !== undefined) { sets.push('x = ?'); vals.push(coord(flags.x, '--x')); }
    if (flags.y !== undefined) { sets.push('y = ?'); vals.push(coord(flags.y, '--y')); }
    if (!sets.length) die('nothing to edit (--title/--body/--url/--imp/--urg/--x/--y)', EXIT.USAGE);
    const fields = sets.map(s => s.split(' ')[0]);
    sets.push('updated_at = ?'); vals.push(now(), id);
    db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    emit({ id, fields }, `edited #${id}`);
  },

  status({ pos }) {
    const db = openDb();
    const id = intArg(pos[0], 'id');
    const st = normStatus(String(pos[1] || ''));
    if (!STATUSES.includes(st)) die(`status must be one of: ${STATUSES.join(' ')}`, EXIT.USAGE);
    getCard(db, id);
    if (st === 'archived') archiveCard(db, id);  // status + geometry agree (design §3)
    else db.prepare('UPDATE cards SET status = ?, updated_at = ? WHERE id = ?').run(st, now(), id);
    emit({ id, status: st }, `#${id} -> ${st}`);
  },

  link({ pos, flags }) {
    const db = openDb();
    const [p, c] = [intArg(pos[0], 'parent'), intArg(pos[1], 'child')];
    const kind = flags.kind ? String(flags.kind) : 'child';
    if (!['child', 'ref'].includes(kind)) die('--kind must be child|ref', EXIT.USAGE);
    getCard(db, p); getCard(db, c);
    if (p === c) die('cannot link a card to itself', EXIT.POLICY);
    try { db.prepare('INSERT INTO links(parent,child,kind) VALUES(?,?,?)').run(p, c, kind); }
    catch (e) {
      if (/UNIQUE|PRIMARY KEY/.test(e.message)) die(`link #${p} -> #${c} already exists`, EXIT.POLICY, 'card unlink first to change its kind');
      die(e.message);
    }
    emit({ parent: p, child: c, kind }, `linked #${p} -${kind}-> #${c}`);
  },

  unlink({ pos }) {
    const db = openDb();
    const [p, c] = [intArg(pos[0], 'parent'), intArg(pos[1], 'child')];
    const r = db.prepare('DELETE FROM links WHERE parent = ? AND child = ?').run(p, c);
    if (!r.changes) die(`no link #${p} -> #${c}`, EXIT.NOTFOUND, `card show ${c} lists its parents`);
    emit({ parent: p, child: c }, `unlinked #${p} -> #${c}`);
  },

  // atomic all-or-nothing advisory lock (design §2) — exit 4 (EXIT.LOCK) on any conflict
  lock({ pos, flags }) {
    const db = openDb();
    const erg = ergId(flags);
    const ids = pos.map(v => intArg(v, 'id'));
    if (!ids.length) die('lock <id...>', EXIT.USAGE);
    const qs = ids.map(() => '?').join(',');
    db.exec('BEGIN IMMEDIATE');
    const r = db.prepare(
      `UPDATE cards SET lock_erg = ?, lock_at = ?, updated_at = ? WHERE id IN (${qs}) AND lock_erg IS NULL`)
      .run(erg, now(), now(), ...ids);  // updated_at bump: 🔒 flips must ride the board's delta polls (card #614)
    if (r.changes !== ids.length) {
      db.exec('ROLLBACK');
      const held = db.prepare(
        `SELECT id, lock_erg FROM cards WHERE id IN (${qs}) AND lock_erg IS NOT NULL`).all(...ids);
      const missing = ids.length - db.prepare(
        `SELECT COUNT(*) n FROM cards WHERE id IN (${qs})`).get(...ids).n;
      die(`lock refused (all-or-nothing): ` +
        (held.length ? `held: ${held.map(h => `#${h.id} by erg:${h.lock_erg}`).join(', ')}` : '') +
        (missing ? ` ${missing} id(s) not found` : ''),
        EXIT.LOCK,
        held.length ? 'wait for that erg to end (locks auto-release on exit; `card reap` clears dead ones)' : 'check the ids',
        { held: held.map(h => ({ id: h.id, erg: h.lock_erg })), missing });
    }
    db.exec('COMMIT');
    emit({ locked: ids, erg }, `locked ${ids.map(i => '#' + i).join(' ')} for erg:${erg}`);
  },

  unlock({ pos, flags }) {
    const db = openDb();
    const erg = ergId(flags);
    let r;
    if (pos.length) {
      const ids = pos.map(v => intArg(v, 'id'));
      const qs = ids.map(() => '?').join(',');
      r = db.prepare(`UPDATE cards SET lock_erg = NULL, lock_at = NULL, updated_at = ?
                      WHERE id IN (${qs}) AND lock_erg = ?`).run(now(), ...ids, erg);
    } else {  // release all leftovers held by this erg
      r = db.prepare('UPDATE cards SET lock_erg = NULL, lock_at = NULL, updated_at = ? WHERE lock_erg = ?').run(now(), erg);
    }
    emit({ unlocked: r.changes, erg }, `unlocked ${r.changes} card(s) for erg:${erg}`);
  },

  search({ pos }) {
    const db = openDb();
    const pat = pos[0];
    if (!pat) die('search <regex>', EXIT.USAGE);
    const rows = db.prepare(
      `SELECT * FROM cards WHERE title REGEXP ? OR body REGEXP ? ORDER BY updated_at DESC LIMIT 50`)
      .all(pat, pat);
    emit(rows, rows.length ? rows.map(line) : '(no matches)');
  },

  // archive a whole thread (design §3, spec frozen erg 135; same logic as web/server.js)
  'archive-thread'({ pos }) {
    const db = openDb();
    const id = intArg(pos[0], 'id');
    getCard(db, id);
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = archiveThread(db, id);
      db.exec('COMMIT');
      const lines = [`archived ${r.archived.length}: ${r.archived.map(i => '#' + i).join(' ') || '(none)'}`];
      if (r.kept.length) lines.push(`kept (live parent outside thread): ${r.kept.map(i => '#' + i).join(' ')}`);
      emit(r, lines);
    } catch (e) { db.exec('ROLLBACK'); die(e.message); }
  },

  reap() {
    const db = openDb();
    const reaped = reap(db);
    emit({ reaped }, reaped.length ? reaped.map(h => `reaped lock on #${h.id} (erg:${h.erg} ${h.reason})`) : 'nothing to reap');
  },

  // --- erg lifecycle (used by erg.js in M3; here for lock ownership + tests) ---
  'erg-start'({ flags }) {
    const db = openDb();
    const mode = flags.target !== undefined ? 'targeted' : String(flags.mode || 'generic');
    if (!['generic', 'targeted'].includes(mode)) die('--mode generic|targeted', EXIT.USAGE);
    const r = db.prepare(
      'INSERT INTO ergs(mode,target_card,pid,status,started_at) VALUES(?,?,?,?,?)').run(
      mode,
      flags.target !== undefined ? intArg(flags.target, '--target') : null,
      flags.pid !== undefined ? intArg(flags.pid, '--pid') : process.ppid,
      'running', now());
    emit({ id: Number(r.lastInsertRowid), mode }, String(r.lastInsertRowid));   // bare id — capture with $(...)
  },

  'erg-end'({ pos, flags }) {
    const db = openDb();
    const id = intArg(pos[0], 'erg id');
    const st = String(flags.status || 'done');
    if (!['done', 'failed'].includes(st)) die('--status done|failed', EXIT.USAGE);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE ergs SET status = ?, ended_at = ?, result = ? WHERE id = ?')
      .run(st, now(), flags.result !== undefined ? String(flags.result) : null, id);
    const r = db.prepare('UPDATE cards SET lock_erg = NULL, lock_at = NULL, updated_at = ? WHERE lock_erg = ?').run(now(), id);
    db.exec('COMMIT');
    emit({ erg: id, status: st, released: r.changes }, `erg:${id} ${st}; released ${r.changes} lock(s)`);
  },
};

// ---- archive-thread internals (kept in sync with web/server.js) ----
// Closure = ancestors(start) ∪ descendants(start) over 'child' links — DIRECTIONAL,
// not the connected component (else the guard below could never fire). Guard: a
// member with a live (non-archived) parent OUTSIDE the closure is kept; iterated
// to fixpoint so a kept card's exclusive descendants stay with it.
const AG = { x0: -2240, cols: 8, dx: 280, y0: 700, dy: 180 };  // M2c archive grid
function nextArchiveSlot(db) {
  const taken = db.prepare(
    `SELECT x, y FROM cards WHERE status = 'archived' AND x < 0 AND y > 0`).all();
  const occ = new Set(taken.map(c =>
    Math.round((c.x - AG.x0) / AG.dx) + ':' + Math.round((c.y - AG.y0) / AG.dy)));
  for (let row = 0; row < 10000; row++)
    for (let col = 0; col < AG.cols; col++)
      if (!occ.has(col + ':' + row)) return { x: AG.x0 + col * AG.dx, y: AG.y0 + row * AG.dy };
  return { x: AG.x0, y: AG.y0 };
}
function archiveCard(db, id) {   // status + geometry agree (design §3)
  const c = db.prepare('SELECT x, y FROM cards WHERE id = ?').get(id);
  const inQuadrant = c && c.x != null && c.x < 0 && c.y != null && c.y > 0;
  const slot = inQuadrant ? null : nextArchiveSlot(db);
  db.prepare(`UPDATE cards SET status = 'archived', updated_at = ?` +
             (slot ? ', x = ?, y = ?' : '') + ' WHERE id = ?')
    .run(...(slot ? [now(), slot.x, slot.y, id] : [now(), id]));
}
// Effective y of a card for quadrant tests: own y, else nearest positioned
// 'child'-ancestor (analog of the board's dispPos derive; board picks the
// lowest parent, we take the first found — close enough for a half-plane test).
function effectiveY(db, id, seen = new Set()) {
  if (seen.has(id)) return null;
  seen.add(id);
  const c = db.prepare('SELECT y FROM cards WHERE id = ?').get(id);
  if (!c) return null;
  if (c.y != null) return c.y;
  for (const r of db.prepare(`SELECT parent AS o FROM links WHERE child = ? AND kind = 'child'`).all(id)) {
    const y = effectiveY(db, r.o, seen);
    if (y != null) return y;
  }
  return null;
}
// Follow only arrows the human can SEE on the board (operator directive 2026-08-19, #1708):
// the board hides edges touching archived cards and edges crossing the y=0
// axis (interface = lower half, y>0). So traversal stops at archived cards
// and never steps to a card outside the interface half. Positionless cards
// inherit y from their chain (effectiveY); unresolvable y → treated followable.
// (Approximation: board tests card CENTER y>0, we test stored top y>0.)
function followable(db, oid) {
  const c = db.prepare('SELECT status FROM cards WHERE id = ?').get(oid);
  if (!c || c.status === 'archived') return false;
  const y = effectiveY(db, oid);
  return y == null || y > 0;
}
function threadClosure(db, id) {
  const seen = new Set([id]);
  const up = db.prepare(`SELECT parent AS o FROM links WHERE child = ? AND kind = 'child'`);
  const down = db.prepare(`SELECT child AS o FROM links WHERE parent = ? AND kind = 'child'`);
  for (const stmt of [up, down]) {
    const queue = [id];
    while (queue.length)
      for (const r of stmt.all(queue.pop()))
        if (!seen.has(r.o) && followable(db, r.o)) { seen.add(r.o); queue.push(r.o); }
  }
  return seen;
}
function archiveThread(db, id) {
  const closure = threadClosure(db, id);
  const parentsOf = db.prepare(
    `SELECT p.id, p.status FROM links l JOIN cards p ON p.id = l.parent
     WHERE l.child = ? AND l.kind = 'child'`);
  const kept = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const cid of closure) {
      if (kept.has(cid)) continue;
      // guard counts only parents whose arrow the human can see (followable);
      // an invisible parent (archived / outside the interface half) can't
      // anchor a card in "another thread" the human is looking at (#1708)
      const liveOutside = parentsOf.all(cid).some(p =>
        (!closure.has(p.id) || kept.has(p.id)) && followable(db, p.id));
      if (liveOutside) { kept.add(cid); changed = true; }
    }
  }
  const archived = [];
  for (const cid of closure)
    if (!kept.has(cid)) { archiveCard(db, cid); archived.push(cid); }
  return { archived: archived.sort((a, b) => a - b), kept: [...kept].sort((a, b) => a - b) };
}

// clear locks whose erg pid is dead or lock_at stale; mark those ergs failed (design §2)
// returns [{id, erg, reason}] — silent; the `reap` command prints
function reap(db) {
  const held = db.prepare(
    `SELECT c.id, c.lock_erg, c.lock_at, e.pid, e.status FROM cards c
     LEFT JOIN ergs e ON e.id = c.lock_erg WHERE c.lock_erg IS NOT NULL`).all();
  const cutoff = new Date(Date.now() - STALE_LOCK_MIN * 60 * 1000).toISOString();
  const reaped = [];
  for (const h of held) {
    const dead = !pidAlive(h.pid);
    const stale = (h.lock_at && h.lock_at < cutoff) || dead;
    if (!stale) continue;
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE cards SET lock_erg = NULL, lock_at = NULL, updated_at = ? WHERE id = ? AND lock_erg = ?')
      .run(now(), h.id, h.lock_erg);
    db.prepare(`UPDATE ergs SET status = 'failed', ended_at = COALESCE(ended_at, ?)
                WHERE id = ? AND status = 'running'`).run(now(), h.lock_erg);
    db.exec('COMMIT');
    reaped.push({ id: h.id, erg: h.lock_erg, reason: dead ? 'pid dead' : 'stale' });
  }
  return reaped;
}

// ------------------------------------------------------------------- main ---
const HELP = `card — sqlite card-board CLI (db: ${DB_PATH})
  card init                                   create/verify the db
  card tips                                   live, unlocked, childless work cards
  card show <id>                              card + body + parent chain (3) + children
  card create --kind K [--title T] [--body B|-] [--parent id]... [--ref id]...
              [--imp N] [--urg N] [--url U] [--x N --y N] [--by WHO]
  card edit <id> [--title T] [--body B|-] [--url U] [--imp N] [--urg N] [--x N|none --y N|none]
  card status <id> draft|done|archived        ('draft' = live; 'ready' retired, accepted as alias)
  card link <parent> <child> [--kind child|ref] · card unlink <parent> <child>
  card archive-thread <id>  archive ancestors+descendants (shared live cards kept) + grid move
  card lock <id...>        atomic all-or-nothing; needs ERG_ID env or --erg (exit 4 = conflict)
  card unlock [id...]      no ids = release everything this erg holds
  card search <regex>      case-insensitive over title+body
  card reap                clear locks of dead/stale ergs
  card erg-start [--mode generic|targeted] [--target id] [--pid N]   -> prints erg id
  card erg-end <erg-id> [--status done|failed] [--result "..."]
  --json (any command)     exactly one JSON value on stdout (show → {card,parents,refs,children};
                           tips/search → [cards]; create → {id}; errors → {error,code,message,hint})
  exit codes: 0 ok · 1 unexpected · 2 usage · 3 not found · 4 lock held · 5 policy · 6 no ERG_ID/--erg`;

const [cmd, ...rest] = process.argv.slice(2).filter(a => a !== '--json');
if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); process.exit(0); }
if (!commands[cmd]) die(`unknown command '${cmd}'`, EXIT.USAGE, 'card help');
// anything a command didn't classify still exits with a class, not a stack trace
try { commands[cmd](parseArgs(rest)); }
catch (e) {
  if (/FOREIGN KEY/.test(e.message)) die(e.message, EXIT.NOTFOUND, 'a referenced card or erg id does not exist (erg ids come from `card erg-start`)');
  die(e.message, EXIT.ERROR);
}
