// ctx — prompt-size + per-call context measurement (operator directive 2026-09-06, card #3440).
// Shared by erg.js (finalize), web/server.js (/cost endpoint, live ergs) and
// tools/backfill-prompt.js (history). Zero deps.
//
//   ctxFromTranscript(file, fromIso, toIso) → { ctx: [n…], out: [n…] }
//     Per API call inside the time window, the CONTEXT SIZE the model saw
//     (input + cache_read + cache_creation tokens) and its output tokens.
//     ctx[0] of a fresh erg = the prompt itself (system + user + tool defs)
//     in real tokens — no char→token guessing. Claude Code writes one
//     assistant line per content block, all sharing a requestId with identical
//     usage → dedupe by requestId (last write wins).
//   sysParts(text) → { mind, memories, kb, tips, harness } chars — the system
//     prompt split on its '━━━ … ━━━' section headers.
//   userParts(text) → { chars, anc } — the fired user prompt; anc = chars from
//     the '── full ancestor context' marker to the end (the "long thread" bit).
'use strict';
const fs = require('fs');

function ctxFromTranscript(file, fromIso, toIso) {
  const from = fromIso ? Date.parse(fromIso) - 1500 : -Infinity;   // ergs table has 1s resolution
  const to = toIso ? Date.parse(toIso) + 1500 : Infinity;
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const byReq = new Map();
  let anon = 0;
  for (const line of txt.split('\n')) {
    if (line.length < 40 || line.indexOf('"assistant"') < 0) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    if (o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const t = Date.parse(o.timestamp || '');
    if (!(t >= from && t <= to)) continue;
    const u = o.message.usage;
    const key = o.requestId || ('anon' + (anon++));
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!ctx) continue;                    // API error stubs carry zero usage — not a call the model saw
    byReq.set(key, { t, ctx, out: u.output_tokens || 0 });
  }
  const rows = [...byReq.values()].sort((a, b) => a.t - b.t);
  return { ctx: rows.map((r) => r.ctx), out: rows.map((r) => r.out) };
}

function sysParts(text) {
  const s = String(text || '');
  const parts = { mind: 0, memories: 0, kb: 0, tips: 0, harness: 0, other: 0 };
  const re = /^━━━ (.+?) ━━━$/gm;
  const heads = []; let m;
  while ((m = re.exec(s))) heads.push({ at: m.index, name: m[1] });
  for (let i = 0; i < heads.length; i++) {
    const len = (i + 1 < heads.length ? heads[i + 1].at : s.length) - heads[i].at;
    const n = heads[i].name;
    const k = /^mind card/.test(n) ? 'mind' : /^memories/.test(n) ? 'memories' : /^knowledge base/.test(n) ? 'kb' :
      /^tips/.test(n) ? 'tips' : /^this erg/.test(n) ? 'harness' : 'other';
    parts[k] += len;
  }
  if (!heads.length) parts.other = s.length;
  return parts;
}

function userParts(text) {
  const s = String(text || '');
  const i = s.indexOf('── full ancestor context');
  return { chars: s.length, anc: i >= 0 ? s.length - i : 0 };
}

module.exports = { ctxFromTranscript, sysParts, userParts };
