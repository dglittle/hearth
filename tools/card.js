#!/usr/bin/env node
// card — CLI over db/cards.db (node:sqlite, zero deps). Design: work/card-board/design.md §5.3.
// Sessions use this instead of raw SQL; every mutation is one short transaction.
//
// Env: CARDS_DB overrides db path (tests); ERG_ID = this erg's id (lock owner / created_by).
//
// Exit codes: 0 ok · 1 usage/not-found error · 2 lock conflict (all-or-nothing refused)

'use strict';
// suppress the node:sqlite ExperimentalWarning (must be registered before require)
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w); });

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.CARDS_DB || path.join(__dirname, '..', 'db', 'cards.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');
const KINDS = ['mind', 'short-term', 'long-term', 'input', 'output', 'work', 'erg'];
const STATUSES = ['draft', 'ready', 'done', 'archived'];
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

function die(msg, code = 1) { console.error('card: ' + msg); process.exit(code); }

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
  if (!Number.isInteger(n)) die(`${name} needs an integer, got ${JSON.stringify(v)}`);
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
  if (v === undefined) die('need --erg <id> or ERG_ID env');
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
  WHERE c.status = 'ready' AND c.lock_erg IS NULL
    AND c.kind IN ('input','work','output','short-term')
    AND NOT EXISTS (
      SELECT 1 FROM links l JOIN cards ch ON ch.id = l.child
      WHERE l.parent = c.id AND l.kind = 'child'
        AND ch.kind != 'erg' AND ch.status != 'archived')
  ORDER BY COALESCE(c.importance,5) + COALESCE(c.urgency,5) DESC, c.updated_at ASC`;

function getCard(db, id) {
  const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!c) die(`no card #${id}`);
  return c;
}

// ---------------------------------------------------------------- commands ---
const commands = {

  init() { openDb(); console.log('db ready: ' + DB_PATH); },

  tips() {
    const db = openDb();
    reap(db, true);
    const rows = db.prepare(TIPS_SQL).all();
    if (!rows.length) return console.log('(no ready tips)');
    for (const c of rows) console.log(line(c));
  },

  show({ pos }) {
    const db = openDb();
    const id = intArg(pos[0], 'id');
    const c = getCard(db, id);
    console.log(line(c));
    console.log(`  by ${c.created_by} at ${c.created_at} · updated ${c.updated_at}` +
      (c.url ? `\n  url: ${c.url}` : ''));
    if (c.body) console.log('  ---\n' + String(c.body).replace(/^/gm, '  '));
    // parent chain, depth 3, 'child' links only
    let level = [id];
    for (let d = 1; d <= 3 && level.length; d++) {
      const qs = level.map(() => '?').join(',');
      const parents = db.prepare(
        `SELECT DISTINCT p.* FROM links l JOIN cards p ON p.id = l.parent
         WHERE l.child IN (${qs}) AND l.kind = 'child'`).all(...level);
      for (const p of parents) console.log(`  ${'^'.repeat(d)} ${line(p)}`);
      level = parents.map(p => p.id);
    }
    const refs = db.prepare(
      `SELECT p.* FROM links l JOIN cards p ON p.id = l.parent
       WHERE l.child = ? AND l.kind = 'ref'`).all(id);
    for (const r of refs) console.log(`  ~ref~ ${line(r)}`);
    const kids = db.prepare(
      `SELECT ch.*, l.kind AS lkind FROM links l JOIN cards ch ON ch.id = l.child
       WHERE l.parent = ?`).all(id);
    for (const k of kids) console.log(`  ${k.lkind === 'ref' ? '~>' : '->'} ${line(k)}`);
  },

  create({ flags }) {
    const db = openDb();
    const kind = String(flags.kind || '');
    if (!KINDS.includes(kind)) die(`--kind must be one of: ${KINDS.join(' ')}`);
    if (!flags.title || flags.title === true) die('--title required');
    const status = flags.status ? String(flags.status) : 'draft';
    if (!STATUSES.includes(status)) die(`--status must be one of: ${STATUSES.join(' ')}`);
    const t = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = db.prepare(
        `INSERT INTO cards(kind,title,body,status,x,y,importance,urgency,url,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        kind, String(flags.title), flags.body !== undefined ? readBody(flags.body) : '',
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
      console.log(`created #${id}`);
    } catch (e) { db.exec('ROLLBACK'); die(e.message); }
  },

  edit({ pos, flags }) {
    const db = openDb();
    const id = intArg(pos[0], 'id');
    getCard(db, id);
    const sets = [], vals = [];
    if (flags.title !== undefined) { sets.push('title = ?'); vals.push(String(flags.title)); }
    if (flags.body !== undefined) { sets.push('body = ?'); vals.push(readBody(flags.body)); }
    if (flags.url !== undefined) { sets.push('url = ?'); vals.push(String(flags.url)); }
    if (flags.imp !== undefined) { sets.push('importance = ?'); vals.push(intArg(flags.imp, '--imp')); }
    if (flags.urg !== undefined) { sets.push('urgency = ?'); vals.push(intArg(flags.urg, '--urg')); }
    if (!sets.length) die('nothing to edit (--title/--body/--url/--imp/--urg)');
    sets.push('updated_at = ?'); vals.push(now(), id);
    db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    console.log(`edited #${id}`);
  },

  status({ pos }) {
    const db = openDb();
    const id = intArg(pos[0], 'id');
    const st = String(pos[1] || '');
    if (!STATUSES.includes(st)) die(`status must be one of: ${STATUSES.join(' ')}`);
    getCard(db, id);
    db.prepare('UPDATE cards SET status = ?, updated_at = ? WHERE id = ?').run(st, now(), id);
    console.log(`#${id} -> ${st}`);
  },

  link({ pos, flags }) {
    const db = openDb();
    const [p, c] = [intArg(pos[0], 'parent'), intArg(pos[1], 'child')];
    const kind = flags.kind ? String(flags.kind) : 'child';
    if (!['child', 'ref'].includes(kind)) die('--kind must be child|ref');
    getCard(db, p); getCard(db, c);
    if (p === c) die('cannot link a card to itself');
    try { db.prepare('INSERT INTO links(parent,child,kind) VALUES(?,?,?)').run(p, c, kind); }
    catch (e) { die(e.message); }
    console.log(`linked #${p} -${kind}-> #${c}`);
  },

  unlink({ pos }) {
    const db = openDb();
    const [p, c] = [intArg(pos[0], 'parent'), intArg(pos[1], 'child')];
    const r = db.prepare('DELETE FROM links WHERE parent = ? AND child = ?').run(p, c);
    if (!r.changes) die(`no link #${p} -> #${c}`);
    console.log(`unlinked #${p} -> #${c}`);
  },

  // atomic all-or-nothing advisory lock (design §2) — exit 2 on any conflict
  lock({ pos, flags }) {
    const db = openDb();
    const erg = ergId(flags);
    const ids = pos.map(v => intArg(v, 'id'));
    if (!ids.length) die('lock <id...>');
    const qs = ids.map(() => '?').join(',');
    db.exec('BEGIN IMMEDIATE');
    const r = db.prepare(
      `UPDATE cards SET lock_erg = ?, lock_at = ? WHERE id IN (${qs}) AND lock_erg IS NULL`)
      .run(erg, now(), ...ids);
    if (r.changes !== ids.length) {
      db.exec('ROLLBACK');
      const held = db.prepare(
        `SELECT id, lock_erg FROM cards WHERE id IN (${qs}) AND lock_erg IS NOT NULL`).all(...ids);
      const missing = ids.length - db.prepare(
        `SELECT COUNT(*) n FROM cards WHERE id IN (${qs})`).get(...ids).n;
      die(`lock refused (all-or-nothing): ` +
        (held.length ? `held: ${held.map(h => `#${h.id} by erg:${h.lock_erg}`).join(', ')}` : '') +
        (missing ? ` ${missing} id(s) not found` : ''), 2);
    }
    db.exec('COMMIT');
    console.log(`locked ${ids.map(i => '#' + i).join(' ')} for erg:${erg}`);
  },

  unlock({ pos, flags }) {
    const db = openDb();
    const erg = ergId(flags);
    let r;
    if (pos.length) {
      const ids = pos.map(v => intArg(v, 'id'));
      const qs = ids.map(() => '?').join(',');
      r = db.prepare(`UPDATE cards SET lock_erg = NULL, lock_at = NULL
                      WHERE id IN (${qs}) AND lock_erg = ?`).run(...ids, erg);
    } else {  // release all leftovers held by this erg
      r = db.prepare('UPDATE cards SET lock_erg = NULL, lock_at = NULL WHERE lock_erg = ?').run(erg);
    }
    console.log(`unlocked ${r.changes} card(s) for erg:${erg}`);
  },

  search({ pos }) {
    const db = openDb();
    const pat = pos[0];
    if (!pat) die('search <regex>');
    const rows = db.prepare(
      `SELECT * FROM cards WHERE title REGEXP ? OR body REGEXP ? ORDER BY updated_at DESC LIMIT 50`)
      .all(pat, pat);
    if (!rows.length) return console.log('(no matches)');
    for (const c of rows) console.log(line(c));
  },

  reap() { const db = openDb(); reap(db, false); },

  // --- erg lifecycle (used by erg.js in M3; here for lock ownership + tests) ---
  'erg-start'({ flags }) {
    const db = openDb();
    const mode = flags.target !== undefined ? 'targeted' : String(flags.mode || 'generic');
    if (!['generic', 'targeted'].includes(mode)) die('--mode generic|targeted');
    const r = db.prepare(
      'INSERT INTO ergs(mode,target_card,pid,status,started_at) VALUES(?,?,?,?,?)').run(
      mode,
      flags.target !== undefined ? intArg(flags.target, '--target') : null,
      flags.pid !== undefined ? intArg(flags.pid, '--pid') : process.ppid,
      'running', now());
    console.log(String(r.lastInsertRowid));   // bare id — capture with $(...)
  },

  'erg-end'({ pos, flags }) {
    const db = openDb();
    const id = intArg(pos[0], 'erg id');
    const st = String(flags.status || 'done');
    if (!['done', 'failed'].includes(st)) die('--status done|failed');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE ergs SET status = ?, ended_at = ?, result = ? WHERE id = ?')
      .run(st, now(), flags.result !== undefined ? String(flags.result) : null, id);
    const r = db.prepare('UPDATE cards SET lock_erg = NULL, lock_at = NULL WHERE lock_erg = ?').run(id);
    db.exec('COMMIT');
    console.log(`erg:${id} ${st}; released ${r.changes} lock(s)`);
  },
};

// clear locks whose erg pid is dead or lock_at stale; mark those ergs failed (design §2)
function reap(db, quiet) {
  const held = db.prepare(
    `SELECT c.id, c.lock_erg, c.lock_at, e.pid, e.status FROM cards c
     LEFT JOIN ergs e ON e.id = c.lock_erg WHERE c.lock_erg IS NOT NULL`).all();
  const cutoff = new Date(Date.now() - STALE_LOCK_MIN * 60 * 1000).toISOString();
  let n = 0;
  for (const h of held) {
    const stale = (h.lock_at && h.lock_at < cutoff) || !pidAlive(h.pid);
    if (!stale) continue;
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE cards SET lock_erg = NULL, lock_at = NULL WHERE id = ? AND lock_erg = ?')
      .run(h.id, h.lock_erg);
    db.prepare(`UPDATE ergs SET status = 'failed', ended_at = COALESCE(ended_at, ?)
                WHERE id = ? AND status = 'running'`).run(now(), h.lock_erg);
    db.exec('COMMIT');
    n++;
    if (!quiet) console.log(`reaped lock on #${h.id} (erg:${h.lock_erg} ${!pidAlive(h.pid) ? 'pid dead' : 'stale'})`);
  }
  if (!quiet && !n) console.log('nothing to reap');
}

// ------------------------------------------------------------------- main ---
const HELP = `card — sqlite card-board CLI (db: ${DB_PATH})
  card init                                   create/verify the db
  card tips                                   ready, unlocked, childless work cards
  card show <id>                              card + body + parent chain (3) + children
  card create --kind K --title T [--body B|-] [--parent id]... [--ref id]...
              [--status draft|ready] [--imp N] [--urg N] [--url U] [--x N --y N] [--by WHO]
  card edit <id> [--title T] [--body B|-] [--url U] [--imp N] [--urg N]
  card status <id> draft|ready|done|archived
  card link <parent> <child> [--kind child|ref] · card unlink <parent> <child>
  card lock <id...>        atomic all-or-nothing; needs ERG_ID env or --erg (exit 2 = conflict)
  card unlock [id...]      no ids = release everything this erg holds
  card search <regex>      case-insensitive over title+body
  card reap                clear locks of dead/stale ergs
  card erg-start [--mode generic|targeted] [--target id] [--pid N]   -> prints erg id
  card erg-end <erg-id> [--status done|failed] [--result "..."]`;

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); process.exit(0); }
if (!commands[cmd]) die(`unknown command '${cmd}' — try: card help`);
commands[cmd](parseArgs(rest));
