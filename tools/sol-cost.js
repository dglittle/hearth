#!/usr/bin/env node
// sol-cost — API-equivalent cost of a codex (OpenAI) session run on the ChatGPT sub ($0 paid).
// the operator's rule (card #3623, erg 1472): every robot's cost line is the API-equivalent, Sol included.
//
//   node tools/sol-cost.js <round-dir>            # uses <dir>/t0 (or sol-t0) as the start stamp; appends to sol-report.md
//   node tools/sol-cost.js --t0 2026-09-08T13:19:18Z [--cwd /path/to/worktree] [--no-append]
//   node tools/sol-cost.js --file ~/.codex/sessions/.../rollout-*.jsonl
//
// Ledger = the LAST "total_token_usage" in the session jsonl (cumulative; the "tokens used" codex prints at
// exit is the final context size, not the total). Session picked = first rollout whose session_meta timestamp
// is >= t0 (and, if --cwd given, whose cwd matches). Cheap/API mode: <dir>/sol-usage.json (chat/completions usage).
// Pricing convention: $5/M input · $0.50/M cached input · $30/M output (gpt-5.6-sol list); PRICE_IN/PRICE_CACHED/PRICE_OUT env override.
const fs = require('fs'), path = require('path'), os = require('os');
const PRICE = { in: +(process.env.PRICE_IN || 5), cached: +(process.env.PRICE_CACHED || 0.5), out: +(process.env.PRICE_OUT || 30) };   // $/M; env override for other OpenAI models (gpt-6-astra = 10/1/50)
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const noAppend = args.includes('--no-append');
let dir = args.find(a => !a.startsWith('--') && (args.indexOf(a) === 0 || !args[args.indexOf(a) - 1].startsWith('--')));
if (dir && !fs.existsSync(dir)) dir = null;
let t0 = opt('--t0'), cwd = opt('--cwd'), file = opt('--file');
if (dir) {
  for (const f of ['sol-t0', 't0']) { const p = path.join(dir, f); if (!t0 && fs.existsSync(p)) t0 = fs.readFileSync(p, 'utf8').trim(); }
}
function price(u) {
  const inTok = u.input_tokens || u.prompt_tokens || 0;
  const cached = u.cached_input_tokens || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  const out = u.output_tokens || u.completion_tokens || 0;
  const usd = ((inTok - cached) * PRICE.in + cached * PRICE.cached + out * PRICE.out) / 1e6;
  return { inTok, cached, out, usd };
}
function fmt(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
function line(p, src) {
  return `cost=$${p.usd.toFixed(2)} API-equiv ($0 paid, ChatGPT sub) · ${fmt(p.inTok)} in (${p.cached ? Math.round(100 * p.cached / p.inTok) : 0}% cached) / ${fmt(p.out)} out · $${PRICE.in}/$${PRICE.cached}/$${PRICE.out} per M · ledger ${src}`;
}
let out;
if (!file && dir && fs.existsSync(path.join(dir, 'sol-usage.json'))) {          // cheap/API mode
  const u = JSON.parse(fs.readFileSync(path.join(dir, 'sol-usage.json'), 'utf8'));
  out = line(price(u), 'sol-usage.json (API mode, real spend = this amount)');
} else {
  if (!file) {
    if (!t0) { console.error('need <round-dir> with t0, --t0 <iso>, or --file <jsonl>'); process.exit(2); }
    const T0 = Date.parse(t0) - 60e3;   // 1 min slack: t0 is written just before codex starts
    const root = path.join(os.homedir(), '.codex', 'sessions');
    const cands = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) cands.push(p); } };
    walk(root);
    let best = null;
    for (const p of cands) {
      const head = fs.readFileSync(p, 'utf8').split('\n')[0] || '';
      let meta; try { meta = JSON.parse(head); } catch { continue; }
      if (!meta || meta.type !== 'session_meta') continue;
      const ts = Date.parse(meta.timestamp || (meta.payload && meta.payload.timestamp));
      if (!(ts >= T0)) continue;
      if (cwd && meta.payload && meta.payload.cwd && path.resolve(meta.payload.cwd) !== path.resolve(cwd)) continue;
      if (!best || ts < best.ts) best = { p, ts };
    }
    if (!best) { console.error('no codex session at/after ' + t0); process.exit(3); }
    file = best.p;
  }
  const txt = fs.readFileSync(file, 'utf8');
  const m = [...txt.matchAll(/"total_token_usage":(\{[^}]*\})/g)];
  if (!m.length) { console.error('no total_token_usage in ' + file); process.exit(3); }
  const u = JSON.parse(m[m.length - 1][1]);
  out = line(price(u), path.basename(file));
}
console.log(out);
if (dir && !noAppend) {
  const rep = path.join(dir, 'sol-report.md');
  if (fs.existsSync(rep) && !fs.readFileSync(rep, 'utf8').includes('API-equiv')) fs.appendFileSync(rep, '\n\n---\n' + out + '\n');
}
