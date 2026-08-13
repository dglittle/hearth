// server.js — {{AGENT_NAME}}'s card-board server (M4a): https://<host>:{{PORT}}/#k=<key>
//
// Serves the board UI (web/board.html, M4b) and a live view of db/cards.db:
//   GET  /data  → { cards, links, ergs, ids, divider:0, generated_at } from sqlite
//                 (?since=<iso> = delta: only cards updated since; ids always full
//                  so the client can drop deleted cards)
//   POST /act   → one board action, applied in ONE transaction + appended to acts:
//                 create · edit · move · status · link · unlink · archive-thread ·
//                 erg {card_ids[]} (spawns `erg.js --card N [--card M…]` detached,
//                 with dup-target refusal — §5b: no generic ergs)
//   GET  /limits, /report — kept from the watch-page server (rate dials, 🧾 html)
//
// Auth: every API call needs ?k=<key> (web/key.txt). Page stores it from #k=.
// TLS: certs from host.conf. Env: BOARD_PORT (test port), CARDS_DB (test db —
// passed through to spawned ergs, as is ERG_CLAUDE_BIN for the stub).
// Design: work/card-board/design.md §3–4 + §5b.

'use strict';
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.error(w); });

const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BOOT = Date.now(); // part of the page version: restart => clients reload

const PORT = parseInt(process.env.BOARD_PORT || '{{PORT}}', 10);
const HOME = path.join(__dirname, '..');
// Guard (sibling-agent incident, 2026-08-04): a CARDS_DB pointing outside this home
// is almost certainly env leaked from an erg that relaunched us — one agent's board
// relaunch once cross-wired a sibling agent's board to the wrong db for ~35h.
// Ignore + scrub it (scrub so spawned ergs don't inherit it either) unless
// BOARD_TEST=1 (test hook).
if (process.env.CARDS_DB && !process.env.BOARD_TEST &&
    !path.resolve(process.env.CARDS_DB).startsWith(path.resolve(HOME) + path.sep)) {
  console.error('ignoring foreign CARDS_DB (leaked env?): ' + process.env.CARDS_DB);
  delete process.env.CARDS_DB;
}
const DB_PATH = process.env.CARDS_DB || path.join(HOME, 'db', 'cards.db');
const ERG_JS = path.join(HOME, 'erg.js');
const REPORTS = path.join(HOME, 'output', 'reports'); // legacy 🧾 html companions
const IMGS = path.join(HOME, 'imgs');                 // pasted images (#1168): board POST /img → file; {{AGENT_NAME}} reads imgs/<name> from disk
const KEY = fs.readFileSync(path.join(__dirname, 'key.txt'), 'utf8').trim();

// ---- host.conf: per-host paths (gitignored; see ../host.conf.example) ----
const CONF = {};
try {
  for (const l of fs.readFileSync(path.join(HOME, 'host.conf'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && l.trim()[0] !== '#') CONF[m[1]] = m[2];
  }
} catch (_) {}
const CERT = CONF.TLS_CERT || '', KEYF = CONF.TLS_KEY || '';

const log = (m) => console.log(new Date().toISOString() + ' ' + m);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

// ---- db (single handle; WAL: reads never block the erg writers) ----
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
try { db.exec('ALTER TABLE ergs ADD COLUMN sid TEXT'); } catch (_) {}  // migration (warm-resume, card #756)
// seen-set is server-side so gold ✦ new syncs across machines (card #971).
// Row id=0 = "seeded" sentinel (card ids start at 1) — until a client seeds
// (one-time migration from its localStorage set), clients keep local behavior.
db.exec('CREATE TABLE IF NOT EXISTS seen (id INTEGER PRIMARY KEY)');

const KINDS = ['mind', 'memory', 'human', '{{AGENT_NAME}}', 'erg', 'header', 'zone'];
// 'zone' (operator directive 2026-08-12, #1295): decorative colored rectangle behind cards —
// pure organization, no chain semantics; the board paints it under everything.
// two-kind interface (operator directive 2026-07-29, card #275); aliases for stray callers
// 'memory' replaces short-term/long-term (operator directive 2026-08-02, card #780)
const KIND_ALIAS = { input: 'human', output: '{{AGENT_NAME}}', work: '{{AGENT_NAME}}',
  'short-term': 'memory', 'long-term': 'memory' };
const STATUSES = ['draft', 'done', 'archived'];  // 'ready' retired 2026-07-28 (all ergs explicit); 'draft' = live
const normStatus = (s) => (s === 'ready' ? 'draft' : s);  // back-compat for stray callers

// ---- stale-lock reaper (same rule as tools/card.js): dead pid or >60min ----
const STALE_LOCK_MIN = 60;
let lastReap = 0;
function reap(force) {
  if (!force && Date.now() - lastReap < 15_000) return;   // throttle for the 5s poll
  lastReap = Date.now();
  // prune seen ids of deleted cards (keeps the set bounded; sentinel 0 stays)
  try { db.prepare('DELETE FROM seen WHERE id != 0 AND id NOT IN (SELECT id FROM cards)').run(); } catch (_) {}
  const held = db.prepare(
    `SELECT c.id, c.lock_erg, c.lock_at, e.pid FROM cards c
     LEFT JOIN ergs e ON e.id = c.lock_erg WHERE c.lock_erg IS NOT NULL`).all();
  const cutoff = new Date(Date.now() - STALE_LOCK_MIN * 60_000).toISOString();
  for (const h of held) {
    if (!((h.lock_at && h.lock_at < cutoff) || !alive(h.pid))) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE cards SET lock_erg = NULL, lock_at = NULL, updated_at = ? WHERE id = ? AND lock_erg = ?')
        .run(nowIso(), h.id, h.lock_erg);
      db.prepare(`UPDATE ergs SET status = 'failed', ended_at = COALESCE(ended_at, ?)
                  WHERE id = ? AND status = 'running'`).run(nowIso(), h.lock_erg);
      db.exec('COMMIT');
      log('reaped stale lock on #' + h.id + ' (erg:' + h.lock_erg + ')');
    } catch (e) { db.exec('ROLLBACK'); log('reap failed: ' + e.message); }
  }
}

// ---- archive-grid placement (M2c convention, lower-left quadrant) ----
// 8 columns x = -2240..-280 (step 280), rows y = 700 + 180k. First free slot wins.
const AG = { x0: -2240, cols: 8, dx: 280, y0: 700, dy: 180 };
function nextArchiveSlot() {
  const taken = db.prepare(
    `SELECT x, y FROM cards WHERE status = 'archived' AND x < 0 AND y > 0`).all();
  const occ = new Set(taken.map((c) =>
    Math.round((c.x - AG.x0) / AG.dx) + ':' + Math.round((c.y - AG.y0) / AG.dy)));
  for (let row = 0; row < 10000; row++)
    for (let col = 0; col < AG.cols; col++)
      if (!occ.has(col + ':' + row)) return { x: AG.x0 + col * AG.dx, y: AG.y0 + row * AG.dy };
  return { x: AG.x0, y: AG.y0 };  // unreachable
}
function archiveCard(id) {  // status + geometry agree (design §3): archived ⇒ archive grid
  const c = db.prepare('SELECT x, y FROM cards WHERE id = ?').get(id);
  const inQuadrant = c && c.x != null && c.x < 0 && c.y != null && c.y > 0;
  const slot = inQuadrant ? null : nextArchiveSlot();
  db.prepare(`UPDATE cards SET status = 'archived', updated_at = ?` +
             (slot ? ', x = ?, y = ?' : '') + ' WHERE id = ?')
    .run(...(slot ? [nowIso(), slot.x, slot.y, id] : [nowIso(), id]));
}

// ---- plain archive = just that card (operator directive 2026-07-29, card #299) ----
// Supersedes the #256a "pull lone ancestors" behavior (2026-07-28): the 📥
// button archives exactly the highlighted cards, nothing else. Ancestors and
// descendants are only swept by 🗄 archive-thread.

// ---- archive-thread closure (design §3, spec frozen erg 135) ----
// From a card: its ancestors (walk 'child' links up) + everything it points to
// (walk down) — directional, NOT the whole connected component, else the guard
// below could never fire. 'ref' edges NOT followed. Guard: a member with a live
// (non-archived) parent OUTSIDE the closure is left alone (shared cards don't
// vanish from other threads); iterated to fixpoint so descendants of a kept
// card stay with it.
function threadClosure(id) {
  const seen = new Set([id]);
  const up = db.prepare(`SELECT parent AS o FROM links WHERE child = ? AND kind = 'child'`);
  const down = db.prepare(`SELECT child AS o FROM links WHERE parent = ? AND kind = 'child'`);
  for (const stmt of [up, down]) {
    const queue = [id];
    while (queue.length)
      for (const r of stmt.all(queue.pop()))
        if (!seen.has(r.o)) { seen.add(r.o); queue.push(r.o); }
  }
  return seen;
}
function archiveThread(id) {
  const closure = threadClosure(id);
  const parentsOf = db.prepare(
    `SELECT p.id, p.status FROM links l JOIN cards p ON p.id = l.parent
     WHERE l.child = ? AND l.kind = 'child'`);
  const kept = new Set();
  for (let changed = true; changed;) {          // fixpoint: kept cards keep their kids
    changed = false;
    for (const cid of closure) {
      if (kept.has(cid)) continue;
      const liveOutside = parentsOf.all(cid).some((p) =>
        (!closure.has(p.id) || kept.has(p.id)) && p.status !== 'archived');
      if (liveOutside) { kept.add(cid); changed = true; }
    }
  }
  const archived = [];
  for (const cid of closure)
    if (!kept.has(cid)) { archiveCard(cid); archived.push(cid); }
  return { archived: archived.sort((a, b) => a - b), kept: [...kept].sort((a, b) => a - b) };
}

// ---- /data ----
const CARD_COLS = 'id,kind,title,body,status,x,y,w,h,importance,urgency,url,created_by,created_at,updated_at,lock_erg,lock_at';
function dataState(since) {
  reap(false);
  // Delta overlap (card #614): writers stamp updated_at BEFORE their commit
  // lands — BEGIN IMMEDIATE can wait seconds behind busy_timeout, so a poll
  // can advance `since` past a timestamp whose row isn't visible yet; that
  // row would then never appear in any delta ("new erg card only after
  // reload"). Re-sending a 15s overlap makes deltas race-proof; the client
  // upsert (CARDS.set) is idempotent.
  const ts = since ? Date.parse(since) : NaN;
  const full = !since || Number.isNaN(ts);
  const wm = full ? null : new Date(ts - 15_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const cards = full
    ? db.prepare(`SELECT ${CARD_COLS} FROM cards`).all()
    : db.prepare(`SELECT ${CARD_COLS} FROM cards WHERE updated_at >= ?`).all(wm);
  const ids = db.prepare('SELECT id FROM cards').all().map((r) => r.id);
  const links = db.prepare('SELECT parent, child, kind FROM links').all();
  const ergs = db.prepare(
    `SELECT id, target_card, info_card, pid, status, started_at, ended_at, result FROM ergs
     WHERE status = 'running' OR id IN (SELECT id FROM ergs ORDER BY id DESC LIMIT 10)
     ORDER BY id`).all().map((e) => ({ ...e, alive: e.status === 'running' && alive(e.pid) }));
  // cumulative spend (operator directive 2026-08-02, #764): total across ALL ergs, for the
  // titlebar 💸 widget. Tiny aggregate; rides the existing 5s poll.
  const spend = db.prepare(
    'SELECT COALESCE(SUM(usd),0) AS usd, COUNT(*) AS ergs FROM costs').get();
  // server-side seen-set (card #971): full list every poll (small — ints only;
  // the ids array is already full each poll too). ORDER BY = stable JSON for
  // the client's cheap changed-check.
  const seenRows = db.prepare('SELECT id FROM seen ORDER BY id').all().map((r) => r.id);
  return { ok: true, ver: pageVer(), full, generated_at: nowIso(), divider: 0,
           cards, ids, links, ergs, warm: warmSessions(), spend,
           seen: seenRows.filter((id) => id !== 0), seenSeeded: seenRows[0] === 0 };
}

// ---- warm sessions (card #756): {{AGENT_NAME}} output cards whose claude session is
// <1h old and resumable — erg.js resumes when a human CHILD of such a card is
// ergged, so the board badges them (♨) as "reply here = dialog turn, cache hit".
const RESUME_WINDOW_MS = 60 * 60_000;
const TRANSCRIPTS = path.join(require('os').homedir(), '.claude', 'projects', HOME.replace(/[\/._]/g, '-'));
function warmSessions() {
  try {
    const cut = new Date(Date.now() - RESUME_WINDOW_MS).toISOString().replace(/\.\d+Z$/, 'Z');
    const rows = db.prepare(
      `SELECT info_card AS card, sid, ended_at FROM ergs
       WHERE status = 'done' AND sid IS NOT NULL AND info_card IS NOT NULL AND ended_at >= ?
       ORDER BY ended_at DESC`).all(cut);
    const seen = new Set(), warm = [];
    for (const r of rows) {
      if (seen.has(r.card)) continue;
      seen.add(r.card);
      if (!fs.existsSync(path.join(HOME, 'ergs', 'sys-' + r.sid + '.txt')) ||
          !fs.existsSync(path.join(TRANSCRIPTS, r.sid + '.jsonl'))) continue;
      warm.push({ card: r.card, until: Date.parse(r.ended_at) + RESUME_WINDOW_MS });
    }
    return warm;
  } catch (_) { return []; }
}

// ---- /act: each action = ONE transaction + an acts row (audit/replay) ----
const intOrNull = (v, name) => {
  if (v === undefined || v === null) return null;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) throw new Error(name + ' must be an integer');
  return n;
};
const numOrNull = (v, name) => {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(name + ' must be a number');
  return n;
};
function mustCard(id) {
  const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
  if (!c) throw new Error('no card #' + id);
  return c;
}
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
function recordAct(action, payload) {
  db.prepare('INSERT INTO acts(at, action, payload) VALUES(?,?,?)')
    .run(nowIso(), action, JSON.stringify(payload));
}

const ACTIONS = {
  create(p) {
    p.kind = KIND_ALIAS[p.kind] || p.kind;
    if (!KINDS.includes(p.kind)) throw new Error('kind must be one of: ' + KINDS.join(' '));
    const title = typeof p.title === 'string' ? p.title : '';
    const status = normStatus(p.status || 'draft');
    if (!STATUSES.includes(status)) throw new Error('bad status');
    const parents = (p.parents || []).map((v) => intOrNull(v, 'parent'));
    const refs = (p.refs || []).map((v) => intOrNull(v, 'ref'));
    return tx(() => {
      for (const id of [...parents, ...refs]) mustCard(id);
      const t = nowIso();
      const r = db.prepare(
        `INSERT INTO cards(kind,title,body,status,x,y,importance,urgency,url,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        p.kind, title, String(p.body || ''), status,
        numOrNull(p.x, 'x'), numOrNull(p.y, 'y'),
        intOrNull(p.imp, 'imp'), intOrNull(p.urg, 'urg'),
        p.url ? String(p.url) : null, 'operator', t, t);
      const id = Number(r.lastInsertRowid);
      const link = db.prepare('INSERT INTO links(parent,child,kind) VALUES(?,?,?)');
      for (const par of parents) link.run(par, id, 'child');
      for (const ref of refs) link.run(ref, id, 'ref');
      recordAct('create', p);
      return { id };
    });
  },

  edit(p) {
    const id = intOrNull(p.id, 'id');
    const sets = [], vals = [];
    if (p.kind !== undefined) {   // kind is editable too (operator directive 2026-08-01, #721)
      p.kind = KIND_ALIAS[p.kind] || p.kind;
      if (!KINDS.includes(p.kind)) throw new Error('kind must be one of: ' + KINDS.join(' '));
      sets.push('kind = ?'); vals.push(p.kind);
    }
    const F = { title: 's', body: 's', url: 's', imp: 'i', urg: 'i', x: 'n', y: 'n', w: 'n', h: 'n' };
    const COL = { imp: 'importance', urg: 'urgency' };
    for (const [k, ty] of Object.entries(F)) {
      if (p[k] === undefined) continue;
      sets.push((COL[k] || k) + ' = ?');
      vals.push(ty === 's' ? String(p[k]) : ty === 'i' ? intOrNull(p[k], k) : numOrNull(p[k], k));
    }
    if (!sets.length) throw new Error('nothing to edit');
    return tx(() => {
      mustCard(id);
      sets.push('updated_at = ?'); vals.push(nowIso(), id);
      db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      recordAct('edit', p);
      return { id };
    });
  },

  move(p) {  // drag: relative {ids[],dx,dy}
    const ids = (p.ids || []).map((v) => intOrNull(v, 'id'));
    if (!ids.length) throw new Error('ids[] required');
    const dx = numOrNull(p.dx, 'dx') || 0, dy = numOrNull(p.dy, 'dy') || 0;
    return tx(() => {
      const qs = ids.map(() => '?').join(',');
      db.prepare(`UPDATE cards SET x = COALESCE(x,0) + ?, y = COALESCE(y,0) + ?, updated_at = ?
                  WHERE id IN (${qs})`).run(dx, dy, nowIso(), ...ids);
      recordAct('move', p);
      return { moved: ids.length };
    });
  },

  status(p) {
    const id = intOrNull(p.id, 'id');
    p = { ...p, status: normStatus(p.status) };
    if (!STATUSES.includes(p.status)) throw new Error('bad status');
    return tx(() => {
      mustCard(id);
      if (p.status === 'archived') {         // status ⇒ archive-grid geometry;
        archiveCard(id);                     // just this card (operator directive 2026-07-29, #299)
        recordAct('status', { ...p, archived: [id] });
        return { id, status: p.status, archived: [id] };
      }
      db.prepare('UPDATE cards SET status = ?, updated_at = ? WHERE id = ?')
        .run(p.status, nowIso(), id);
      recordAct('status', p);
      return { id, status: p.status };
    });
  },

  link(p) {
    const parent = intOrNull(p.parent, 'parent'), child = intOrNull(p.child, 'child');
    const kind = p.kind || 'child';
    if (!['child', 'ref'].includes(kind)) throw new Error('link kind must be child|ref');
    if (parent === child) throw new Error('cannot link a card to itself');
    return tx(() => {
      mustCard(parent); mustCard(child);
      db.prepare('INSERT INTO links(parent,child,kind) VALUES(?,?,?)').run(parent, child, kind);
      recordAct('link', p);
      return { parent, child, kind };
    });
  },

  unlink(p) {
    const parent = intOrNull(p.parent, 'parent'), child = intOrNull(p.child, 'child');
    return tx(() => {
      const r = db.prepare('DELETE FROM links WHERE parent = ? AND child = ?').run(parent, child);
      if (!r.changes) throw new Error('no link #' + parent + ' -> #' + child);
      recordAct('unlink', p);
      return { parent, child };
    });
  },

  // ---- server-side seen-set (card #971): gold ✦ new syncs across machines ----
  seen(p) {     // mark cards seen (✦ off everywhere)
    const ids = (p.ids || []).map((v) => intOrNull(v, 'id'));
    if (!ids.length) throw new Error('ids[] required');
    return tx(() => {
      const ins = db.prepare('INSERT OR IGNORE INTO seen(id) VALUES(?)');
      for (const id of ids) if (id > 0) ins.run(id);
      recordAct('seen', p);
      return { marked: ids.length };
    });
  },

  unsee(p) {    // gmail-style "mark unread": ✦ back on everywhere
    const ids = (p.ids || []).map((v) => intOrNull(v, 'id'));
    if (!ids.length) throw new Error('ids[] required');
    return tx(() => {
      const del = db.prepare('DELETE FROM seen WHERE id = ?');
      for (const id of ids) if (id > 0) del.run(id);
      recordAct('unsee', p);
      return { unmarked: ids.length };
    });
  },

  'seen-seed'(p) {  // one-time migration: first board to load pushes its
    const ids = (p.ids || []).map((v) => intOrNull(v, 'id'));  // localStorage set
    return tx(() => {
      if (db.prepare('SELECT 1 FROM seen WHERE id = 0').get()) return { seeded: false };
      const ins = db.prepare('INSERT OR IGNORE INTO seen(id) VALUES(?)');
      ins.run(0);
      for (const id of ids) if (id > 0) ins.run(id);
      recordAct('seen-seed', { n: ids.length });
      return { seeded: true, n: ids.length };
    });
  },

  'archive-thread'(p) {
    const id = intOrNull(p.id, 'id');
    return tx(() => {
      mustCard(id);
      const r = archiveThread(id);
      recordAct('archive-thread', { id, ...r });
      return r;
    });
  },

  erg(p) {  // §5b: parent card(s) ALWAYS passed; dup-target refusal; no generic mode
    const ids = (p.card_ids || []).map((v) => intOrNull(v, 'card_id'));
    if (!ids.length) throw new Error('card_ids[] required (generic ergs are gone — §5b)');
    reap(true);
    for (const id of ids) {
      const c = mustCard(id);
      if (c.lock_erg != null) { const e = new Error('card #' + id + ' is locked by erg:' + c.lock_erg + ' — already being worked'); e.code = 409; throw e; }
      if (c.status === 'archived') { const e = new Error('card #' + id + ' is archived — un-archive first'); e.code = 409; throw e; }
    }
    return tx(() => {
      // ('ready' flip retired 2026-07-28 — all ergs are explicit; ⚡ needs no status change)
      const args = [ERG_JS];
      for (const id of ids) args.push('--card', String(id));
      if (p.extra) args.push(String(p.extra));
      const child = spawn(process.execPath, args,
        { cwd: HOME, detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      recordAct('erg', { ...p, pid: child.pid });
      log('erg fired on card(s) #' + ids.join(',#') + ' (pid ' + child.pid + ')');
      return { pid: child.pid, card_ids: ids };
    });
  },

  'erg-stop'(p) {  // board ⛔: SIGTERM the erg.js process — it kills its claude
    // child and finalizes cleanly (locks, cost line, "⛔ stopped" on the card).
    // Match by erg_id, or by card_ids (a card the erg locked / its output card).
    const ergId = intOrNull(p.erg_id, 'erg_id');
    let rows;
    if (ergId != null) {
      rows = db.prepare(`SELECT id, pid, status FROM ergs WHERE id = ?`).all(ergId);
    } else {
      const ids = (p.card_ids || []).map((v) => intOrNull(v, 'card_id'));
      if (!ids.length) throw new Error('erg_id or card_ids[] required');
      const qs = ids.map(() => '?').join(',');
      rows = db.prepare(
        `SELECT DISTINCT id, pid, status FROM ergs WHERE status = 'running' AND
         (info_card IN (${qs}) OR id IN (SELECT lock_erg FROM cards WHERE id IN (${qs}) AND lock_erg IS NOT NULL))`
        ).all(...ids, ...ids);
    }
    const stopped = [];
    for (const e of rows) {
      if (e.status !== 'running' || !alive(e.pid)) continue;
      try { process.kill(e.pid, 'SIGTERM'); } catch (_) { continue; }
      stopped.push(e.id);
      const pid = e.pid;   // hard fallback: still alive after 25s → SIGKILL the
      setTimeout(() => {   // whole group (erg.js is detached = group leader), reap
        if (!alive(pid)) return;
        log('erg pid ' + pid + ' ignored SIGTERM — SIGKILL group');
        try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        setTimeout(() => reap(true), 2000).unref();
      }, 25_000).unref();
    }
    if (!stopped.length) { const e = new Error('no live running erg matched'); e.code = 409; throw e; }
    recordAct('erg-stop', { ...p, stopped });
    log('⛔ stop sent to erg(s) ' + stopped.join(','));
    return { stopped };
  },
};

// ---- /hud (operator directive 2026-08-06, #988): live claude-stream tail per running erg ----
// The board floats a jet-HUD overlay over each running erg's output card; this
// feeds it. sid comes from the ergs row (erg.js records it at attempt start
// since #988) or, for ergs started before that patch, from the claude child's
// cmdline in /proc (--session-id/--resume <sid>). Reads the transcript's last
// 128KB and compacts it to display lines: tool calls, text, thinking, results.
const hudSidCache = new Map();          // erg id -> sid (proc-scan results)
function hudSid(e) {
  if (e.sid) return e.sid;
  const hit = hudSidCache.get(e.id);
  if (hit) return hit;
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      let stat, cmd;
      try { stat = fs.readFileSync('/proc/' + d + '/stat', 'utf8'); } catch (_) { continue; }
      // stat = "pid (comm) state ppid …" — comm may contain spaces/parens
      const ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
      if (ppid !== e.pid) continue;
      try { cmd = fs.readFileSync('/proc/' + d + '/cmdline', 'utf8'); } catch (_) { continue; }
      const a = cmd.split('\0');
      const i = a.findIndex((x) => x === '--session-id' || x === '--resume');
      if (i >= 0 && a[i + 1]) {
        if (hudSidCache.size > 200) hudSidCache.clear();
        hudSidCache.set(e.id, a[i + 1]);
        return a[i + 1];
      }
    }
  } catch (_) {}
  return null;
}
function hudTail(sid) {
  const f = path.join(TRANSCRIPTS, sid + '.jsonl');
  const st = fs.statSync(f);
  const from = Math.max(0, st.size - 131072);
  const buf = Buffer.alloc(st.size - from);
  const fd = fs.openSync(f, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  const raw = buf.toString('utf8').split('\n');
  if (from > 0) raw.shift();                       // drop the cut-off first line
  // Thinking TEXT never reaches the transcript (blocks carry only a signature —
  // content is encrypted out), so per-turn thinking tokens are ESTIMATED:
  // usage.output_tokens is the whole turn and is repeated on every block-entry
  // of that turn; subtract the visible blocks' chars/4 (#1004b).
  // Pass 1: parse events + aggregate per turn (message.id).
  const evs = [], turns = new Map();
  let lastT = null;                                // last user/assistant entry type
  for (const ln of raw) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type === 'user' || o.type === 'assistant') lastT = o.type;
    const cont = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    const mid = o.type === 'assistant' && o.message && o.message.id;
    let tn = null;
    if (mid) {
      tn = turns.get(mid) || { out: 0, vis: 0, think: false };
      const u = o.message.usage;
      if (u && u.output_tokens > tn.out) tn.out = u.output_tokens;
      turns.set(mid, tn);
    }
    for (const c of cont) {
      if (o.type === 'assistant' && c.type === 'tool_use') {
        if (tn) tn.vis += (c.name || '').length + JSON.stringify(c.input || {}).length;
        evs.push({ o, c });
      } else if (o.type === 'assistant' && c.type === 'text') {
        if (tn) tn.vis += String(c.text || '').length;
        evs.push({ o, c });
      } else if (o.type === 'assistant' && c.type === 'thinking') {
        if (tn) { tn.think = true; tn.vis += String(c.thinking || '').length; }
        evs.push({ o, c, mid });
      } else if (o.type === 'user' && c.type === 'tool_result') evs.push({ o, c });
    }
  }
  // Pass 2: build display lines.
  const out = [], sealedSeen = new Set();          // one sealed-thought line per turn
  const push = (k, t) => { t = String(t || '').replace(/\s+/g, ' ').trim();
    if (t) out.push({ k, t: t.slice(0, 140) }); };
  for (const { o, c, mid } of evs) {
    if (c.type === 'tool_use') {
      const i = c.input || {};
      const d = c.name === 'Bash' ? (i.command || i.description) :
        i.file_path ? String(i.file_path).replace(/^.*\//, '') :
        i.pattern || i.query || (typeof i.prompt === 'string' ? i.prompt : '');
      push('tool', '⚒ ' + c.name + (d ? ' · ' + d : ''));
    } else if (c.type === 'text') push('txt', c.text);
    else if (c.type === 'thinking') {
      const txt = String(c.thinking || '').trim();
      const tn = mid && turns.get(mid);
      const est = tn ? Math.max(1, tn.out - Math.round((tn.vis - txt.length) / 4)) : 0;
      if (txt) push('think', '≈ ' + txt);
      else if (!mid || !sealedSeen.has(mid)) {     // interleaved thinking = several blocks/turn; label once
        if (mid) sealedSeen.add(mid);
        push('think', '≈ ⟨thought' + (est ? ' ~' + est + 'tok' : '') + ' — content sealed⟩');
      }
    } else if (c.type === 'tool_result') {
      let s = c.content;
      if (Array.isArray(s)) s = s.map((x) => (x && x.text) || '').join(' ');
      if (typeof s !== 'string') s = JSON.stringify(s || '');
      push('res', '↳ ' + (c.is_error ? '⚠ ' : '') + s);
    }
  }
  // gen: last transcript entry is a user/tool_result → the model is generating
  // (thinking) RIGHT NOW; last assistant entry = a tool is running or turn ended.
  // Transcript-poll granularity is all we have — live deltas aren't on disk (#1004b).
  return { lines: out.slice(-16), gen: lastT === 'user' };
}

// session-wide thinking-token estimate, incremental per sid so we never rescan
// the whole transcript on the 2.5s poll (#1004b). Same accounting as hudTail:
// per turn (message.id), thinking tok ≈ output_tokens − visible chars/4;
// only turns that contain a thinking block count.
const thinkCache = new Map();                      // sid -> {off, tok, cur}
function thinkTok(sid) {
  const f = path.join(TRANSCRIPTS, sid + '.jsonl');
  const st = fs.statSync(f);
  let c = thinkCache.get(sid);
  if (!c || st.size < c.off) c = { off: 0, tok: 0, cur: null };
  const fin = (t) => t && t.think ? Math.max(1, t.out - Math.round(t.vis / 4)) : 0;
  if (st.size > c.off) {
    const buf = Buffer.alloc(st.size - c.off);
    const fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, c.off); } finally { fs.closeSync(fd); }
    const s = buf.toString('utf8');
    const nl = s.lastIndexOf('\n');                // only consume complete lines
    if (nl >= 0) {
      for (const ln of s.slice(0, nl).split('\n')) {
        if (!ln.includes('"assistant"')) continue;
        let o; try { o = JSON.parse(ln); } catch (_) { continue; }
        if (o.type !== 'assistant' || !o.message || !o.message.id) continue;
        if (!c.cur || c.cur.id !== o.message.id) {
          c.tok += fin(c.cur);                     // turn boundary → commit prev
          c.cur = { id: o.message.id, out: 0, vis: 0, think: false };
        }
        const u = o.message.usage;
        if (u && u.output_tokens > c.cur.out) c.cur.out = u.output_tokens;
        const cont = Array.isArray(o.message.content) ? o.message.content : [];
        for (const b of cont) {
          if (b.type === 'thinking') { c.cur.think = true; c.cur.vis += String(b.thinking || '').length; }
          else if (b.type === 'text') c.cur.vis += String(b.text || '').length;
          else if (b.type === 'tool_use') c.cur.vis += (b.name || '').length + JSON.stringify(b.input || {}).length;
        }
      }
      c.off += Buffer.byteLength(s.slice(0, nl + 1), 'utf8');
    }
    if (thinkCache.size > 100) thinkCache.clear();
    thinkCache.set(sid, c);
  }
  return c.tok + fin(c.cur);                       // include the in-progress turn
}

// ---- page version: server boot + board.html hash (auto-reload on change) ----
function pageVer() {
  try { return BOOT + ':' + crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'board.html'))).digest('hex').slice(0, 12); }
  catch (_) { return BOOT + ':?'; }
}

// ---- rate-limit panel (unchanged from the watch-page server) ----
// NO background polling; the page asks /limits?probe=1 on erg-finish/load/↻.
// One probe = one 1-token claude-fable-5 call per token. Cache: web/limits.json.
const LIMITSF = path.join(__dirname, 'limits.json');
const ENVF = CONF.OAUTH_ENV_FILE || '';
const PROBE_MIN_MS = 90_000;
let probing = null;
function readToks() {
  try {
    const t = fs.readFileSync(ENVF, 'utf8');
    return [
      (t.match(/^CLAUDE_CODE_OAUTH_TOKEN=(\S+)/m) || [, ''])[1],
      (t.match(/^CLAUDE_CODE_OAUTH_TOKEN_2=(\S+)/m) || [, ''])[1],
    ];
  } catch (_) { return []; }
}
function probeOne(tok, slot) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'claude-fable-5', max_tokens: 1,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: 'hi' }] });
    const req = https.request({
      host: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok,
        'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 20000 }, (r) => {
      r.resume();
      const h = r.headers;
      const g = (k) => h['anthropic-ratelimit-unified-' + k];
      const bucket = (k) => g(k + '-utilization') === undefined ? null : {
        util: +g(k + '-utilization'),
        reset: (+g(k + '-reset') * 1000) || null,
        status: g(k + '-status') || null };
      r.on('end', () => resolve({ slot, http: r.statusCode, status: g('status') || null,
        buckets: { '5h': bucket('5h'), '7d': bucket('7d'), '7d_oi': bucket('7d_oi') } }));
    });
    req.on('error', (e) => resolve({ slot, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ slot, error: 'timeout' }); });
    req.end(body);
  });
}
function readLimitsCache() {
  try { return JSON.parse(fs.readFileSync(LIMITSF, 'utf8')); } catch (_) { return null; }
}
function probeLimits(why) {
  const toks = readToks();
  return Promise.all(toks.map((t, i) => t ? probeOne(t, i + 1) : null).filter(Boolean))
    .then((slots) => {
      const data = { at: Date.now(), why: why || '', slots };
      try { fs.writeFileSync(LIMITSF, JSON.stringify(data, null, 1)); } catch (_) {}
      log('limits probed (' + (why || '?') + '): ' + slots.map((s) =>
        'tok' + s.slot + ' ' + (s.error ? 'ERR ' + s.error :
          ['5h', '7d', '7d_oi'].map((b) => b + '=' + (s.buckets[b] ? s.buckets[b].util : '?')).join(' '))).join(' | '));
      return data;
    });
}

// ------------------------------------------------------------------ http ---
const handler = (req, res) => {
  const url = new URL(req.url, 'https://x');
  const ok = url.searchParams.get('k') === KEY;
  const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const board = path.join(__dirname, 'board.html');
    if (fs.existsSync(board)) return res.end(fs.readFileSync(board));
    return res.end('<!doctype html><meta charset="utf-8"><title>{{AGENT_NAME}} board</title>' +
      '<body style="font:16px system-ui;padding:2em;background:#111;color:#ddd">' +
      '<h2>card-board server is up (M4a)</h2><p>board.html lands with M4b — ' +
      'meanwhile <code>/data?k=…</code> and <code>POST /act?k=…</code> are live.</p>');
  }
  if (url.pathname === '/report') {
    const name = url.searchParams.get('name') || '';
    if (!name || name.includes('/') || name.includes('..') || !name.endsWith('.html'))
      return j(400, { ok: false, error: 'bad name' });
    if (!ok) {
      // No/bad key: bootstrap from the board's stored key (same origin as /#k=…).
      // Reveals nothing; just retries with localStorage.{{AGENT_NAME}}key if present.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>report</title>' +
        '<body style="font:16px system-ui;padding:2em;background:#111;color:#ddd">' +
        '<p id="m">opening…</p><script>' +
        'const k=localStorage.{{AGENT_NAME}}key||"";' +
        'if(k){const u=new URL(location.href);u.searchParams.set("k",k);location.replace(u);}' +
        'else document.getElementById("m").innerHTML=' +
        '"no key stored — open the board once with <code>/#k=&lt;key&gt;</code>, then reload this page.";' +
        '</script>');
    }
    const p = path.join(REPORTS, name);
    if (!fs.existsSync(p)) return j(404, { ok: false, error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(p));
  }
  if (!ok) return j(403, { ok: false, error: 'bad key' });

  if (url.pathname === '/data') return j(200, dataState(url.searchParams.get('since') || ''));

  // ---- pasted images (operator directive 2026-08-11, #1168) ----
  // POST /img (binary body, image/* content-type) → saves imgs/<name>, returns the
  // markdown to embed; GET /img/<name> serves it (auth'd like everything else).
  if (url.pathname === '/img' && req.method === 'POST') {
    const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    const ext = EXT[(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!ext) return j(400, { ok: false, error: 'unsupported type (png/jpeg/webp/gif)' });
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 8_000_000) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return j(400, { ok: false, error: 'empty body' });
      const d = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const name = 'paste-' + d + '-' + crypto.randomBytes(2).toString('hex') + '.' + ext;
      try {
        fs.mkdirSync(IMGS, { recursive: true });
        fs.writeFileSync(path.join(IMGS, name), Buffer.concat(chunks));
      } catch (e) { return j(500, { ok: false, error: e.message }); }
      log('img saved: ' + name + ' (' + size + ' B)');
      return j(200, { ok: true, name, file: 'imgs/' + name, md: '![img](/img/' + name + ')' });
    });
    return;
  }
  if (url.pathname.startsWith('/img/')) {
    const name = url.pathname.slice(5);
    if (!/^[\w.-]+$/.test(name) || name.includes('..')) return j(400, { ok: false, error: 'bad name' });
    const p = path.join(IMGS, name);
    if (!fs.existsSync(p)) return j(404, { ok: false, error: 'not found' });
    const CT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    res.writeHead(200, { 'Content-Type': CT[name.split('.').pop().toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'private, max-age=31536000, immutable' });      // names are unique → cache forever
    return res.end(fs.readFileSync(p));
  }

  if (url.pathname === '/hud') {                   // jet-HUD stream tails (#988)
    reap(false);
    const running = db.prepare(
      `SELECT id, info_card, pid, sid FROM ergs WHERE status = 'running'`).all()
      .filter((e) => e.info_card && alive(e.pid));
    const huds = [];
    for (const e of running) {
      const sid = hudSid(e);
      let lines = [], gen = false, tt = 0;
      if (sid) try {
        ({ lines, gen } = hudTail(sid));
        tt = thinkTok(sid);
      } catch (_) {}
      huds.push({ erg: e.id, card: e.info_card, lines, gen, tt });
    }
    return j(200, { ok: true, huds });
  }

  if (url.pathname === '/act' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 500_000) req.destroy(); });
    req.on('end', () => {
      let p = null;
      try { p = JSON.parse(b); } catch (_) { return j(400, { ok: false, error: 'bad json' }); }
      const action = p && p.action;
      if (!action || !ACTIONS[action])
        return j(400, { ok: false, error: 'unknown action (have: ' + Object.keys(ACTIONS).join(' ') + ')' });
      try {
        const r = ACTIONS[action](p);
        return j(200, { ok: true, action, ...r });
      } catch (e) {
        return j(e.code === 409 ? 409 : 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  if (url.pathname === '/limits') {
    const cached = readLimitsCache();
    const age = cached ? Date.now() - cached.at : Infinity;
    if (url.searchParams.get('probe') === '1' && !probing && age > PROBE_MIN_MS)
      probing = probeLimits(url.searchParams.get('why') || 'page').finally(() => { probing = null; });
    if (url.searchParams.get('probe') === '1' && probing) {
      probing.then((d) => j(200, { ok: true, ...d }))
             .catch(() => j(200, { ok: true, ...(cached || { at: 0, slots: [] }) }));
      return;
    }
    return j(200, { ok: true, ...(cached || { at: 0, slots: [] }) });
  }

  res.writeHead(404); res.end('{"ok":false}');
};

// TLS if host.conf names cert+key; otherwise plain HTTP
const certs = () => ({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEYF) });
let server;
if (CERT && KEYF) {
  server = https.createServer(certs(), handler);
  fs.watchFile(CERT, () => { try { server.setSecureContext(certs()); log('certs reloaded'); } catch (e) { log('cert reload failed: ' + e.message); } });
} else {
  server = require('http').createServer(handler);
  log('WARNING: no TLS_CERT/TLS_KEY in host.conf — serving plain HTTP');
}
server.listen(PORT, () => log('board server (M4a) listening on :' + PORT + ' · db ' + DB_PATH));
