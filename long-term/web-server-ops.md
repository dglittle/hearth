Web-server ops: how to run/fix/change my watch-page (web/server.js, screen {{AGENT_NAME}}-web, https :{{PORT}}) — part of the hearth seed; yours to manage.

# my web server — operations guide

The page at https://{{HOST}}:{{PORT}}/ is the operator's WINDOW ONTO ME:
erg.log live (my PLAN/DONE lines), unread output/ cards with an "archive"
button, an input drop-box, and the ▶ erg button. If it's down, the operator is blind
— treat outages as a drop-everything chunk. It is MINE to manage — the
operator's standing directive.

## Layout (all inside web/)

- `web/server.js` — HTTPS server, port **{{PORT}}**, ~130 lines, plain node
  (no npm deps). TLS certs from `host.conf` (`TLS_CERT`/`TLS_KEY`;
  fs.watchFile auto-reload on cert renewal; unset => plain HTTP).
- `web/page.html` — the whole UI (vanilla JS, 3s polling). Served fresh from
  disk on every GET /.
- `web/key.txt` — the access key. Every API call needs `?k=<key>`. SECRET:
  never quote it in output/ files or logs (the operator already has the link).
- `web/web.log` — server log (one line per boot/input/archive/erg-fire).

## The ro lane (operator directive 2026-07-26, erg 104; single-column layout since erg 109)

**Page layout v10 (erg 109, the operator 11:58Z ask):** SINGLE column — logs
side-by-side (`#logs` grid: erg.log | ro/ro.log), ONE input box with two
buttons (`drop in` → /input, `⇄ ask` → /ro-ask; Enter = drop in,
Ctrl/Cmd+Enter = ask, one shared draft key '#main'), then `#rooutputs`
(ro answers, newest first, `.card.ro` teal accent + `⇄ ro` badge) ABOVE
`#outputs` (priority-sorted). ro cards are in the gold anchor system
(anchorCapture covers #inputs/#roinputs/#rooutputs/#outputs; `.card.ro`
CSS must stay ABOVE `.card.reading` so gold wins on the anchored card).
⚠ `BOOTED` flag: anchorRestore is a no-op until the first full refresh
completes — in single column the first-load render sequence (main cards,
THEN ro cards inserted above) otherwise scrollBy-yanks a fresh tab down by
the ro-card height (reproduced in /tmp sandbox: 1011px). Keep the guard.

Right column = PARALLEL READ-ONLY ergs ("ro lane"). One ask = one immediate
`node ro-erg.js <file>` (spawned by the server, NO erg.lock — runs alongside
normal ergs; N asks = N concurrent sessions). Lane home = `ro/`:
`ro/input/` (+processed/), `ro/output/` (+processed/), `ro/ro.log`,
`ro/ergs.jsonl`, `ro/ergs/` (transcripts), `ro/running/<pid>` (live-count
files, cleaned by the server). RO ergs get the same mind + short-term index
plus an RO-OVERRIDE block: answer ONLY the ask; writes allowed ONLY to
ro/output/, work/ro/, /tmp; mind/, short-term/, long-term/, input/, output/
(main), web/, stream/, ergs/ are FORBIDDEN — enforced by `--settings`
permission deny-rules for Edit/Write (Bash is honor-system, prompt-covered,
"until we figure a good way" per the operator). They must not mutate shared
work/*/repo checkouts (clone under work/ro/ instead), never fire ergs, and
external actions remain draft-only. ro-erg.js reads tok-pref.json but never
writes it (main lane owns the sticky-token memory). Reply on an ro card =
new /ro-ask with quoted context → fires a fresh parallel erg + auto-archives
the card. Main-lane ergs: treat ro/output/ as operator-facing but NOT yours —
don't triage or archive it; ro/ carries no memory duties.

## Endpoints (all key-gated except GET /)

- `GET  /state`   → `{ok, ver, running, log, outputs, inputs}` — log = last
  200 lines of erg.log; outputs = UNREAD output/ files only (processed/ is
  hidden); running = erg.lock pid alive.
- `GET  /limits` → cached
  rate-limit dials `{ok, at, why, slots:[{slot, http, status, buckets:{5h,
  7d, 7d_oi}}]}` from `web/limits.json`; `?probe=1&why=<tag>` = live probe
  (one 1-token fable call PER token from host.conf's OAUTH_ENV_FILE — ~66 tok total,
  server-debounced to one probe / 90s). Page probes ONLY on: erg-end while
  page open, stale-on-load (>15 min), or ↻ button — NO polling. 7d_oi =
  "fable weekly" bucket (only fable requests carry it — that's why the
  probe model is claude-fable-5).
- `POST /input`   `{text}` → writes `input/web-<ts>.txt`. Plain drop-ins do
  NOT run an erg; but also a
  text starting `REPLY from operator to output/` ALSO auto-queues one erg.js
  (erg.lock serializes → it waits if one is in flight; response carries
  `erg:<pid>`). So every card reply now runs without the operator hitting ▶.
  Used by BOTH the drop-box and the per-output-card reply boxes (erg 9): a
  reply arrives as `REPLY from operator to output/<name>` + the output quoted
  `> `-style + the operator's words unquoted at the end. Treat the unquoted tail as
  the directive; the quoted part is my own prior output for context.
  **Replying AUTO-ARCHIVES the card** (erg 74, operator directive 2026-07-25:
  page fires /archive after a successful reply POST — also moots his
  reply-scroll-jump complaint). So: card in output/processed/ + matching
  REPLY file in input/ = normal replied flow, NOT a silent dismissal;
  "archived silently" (no reply file) still means read-and-dismissed/HOLD.
  Resurface-trigger logic must check for a reply before treating an archive
  as a HOLD signal.
- `POST /archive` `{name}` → moves `output/<name>` → `output/processed/`.
- `POST /erg`     → spawns `node erg.js` detached. NEVER call this from
  inside an erg — that's a fork bomb of myself (each spawned erg queues on
  erg.lock and each costs money).
- `GET  /report?name=<X.html>` → serves `output/reports/<X.html>` (key-gated,
  name sanitized, .html only).
- `POST /ro-ask` `{text}` → writes `ro/input/roq-<ts>.txt` AND immediately
  spawns `node ro-erg.js <name>` (parallel read-only erg — the ONE endpoint
  that auto-runs; still never call it from inside any erg).
- `POST /ro-archive` `{name}` → moves `ro/output/<name>` → `ro/output/processed/`.
- `/state` also carries `ro: {running, log, outputs, inputs}` (running =
  alive pids under ro/running/).

## HTML reports (operator directive 2026-07-25, erg 36)

Convention: an output card `output/X.md` with a companion
`output/reports/X.html` gets a "🧾 diff report" button (page matches by
basename; `/state` carries `reports:[...]`). Use ESPECIALLY for code-approval
asks — the operator wants a diff2-style (Monaco side-by-side, wordWrap+indent) view.
Generate with:
  node tools/make-diff-report.js --repo <path> --base <ref> --head <ref> \
       --title "..." [--summary <md>] --out output/reports/<X>.html
(self-contained HTML, Monaco from cdnjs; file tabs, inline/side-by-side and
wrap toggles, collapsible summary). Reports are NOT archived with the card —
they just sit in reports/; tidy occasionally. Never put the key in report
files; the page adds ?k= itself.

## The ver / auto-reload mechanism

`/state.ver` = `<server BOOT ms>:<sha1 of page.html, read per-request>`.
The page baselines ver on first poll and `location.reload()`s when it
changes. Consequences:
- **Change the UI**: edit `web/page.html` → open tabs reload within ~3s.
  No restart needed. Page linkifies bare URLs + markdown `[text](url)` in
  output/input cards (`linkify()`, target=_blank; operator directive 2026-07-25).
- **Change the server**: edit `web/server.js` → MUST restart (below); the
  new BOOT flips ver → tabs reload themselves.

## Operating it

- Health:  `curl -sk "https://localhost:{{PORT}}/state?k=$(cat web/key.txt)" | head -c 120`
  (expect `{"ok":true,...}`); process: `screen -ls | grep {{AGENT_NAME}}-web`.
- Logs:    `tail -20 web/web.log`
- Restart (ALWAYS `node --check web/server.js` first — a syntax error here
  kills the operator's window):
    screen -S {{AGENT_NAME}}-web -X quit
    cd web && screen -dmS {{AGENT_NAME}}-web bash -c 'exec node server.js >> web.log 2>&1'
  then re-run the health curl.
- Reboot survival: crontab line tagged `# {{AGENT_NAME}}-web` (view: `crontab -l |
  grep {{AGENT_NAME}}-web`). If you rename paths, update that line (edit via
  `crontab -l > /tmp/c && vi-style edit && crontab /tmp/c` — never clobber
  other lines; siblings' cron entries live in the same crontab).
- Port {{PORT}} is mine; don't move it without telling the operator (their bookmark).

## Editing etiquette

- Log a STEP line to erg.log before restarting the server (the operator may be
  watching the very page you're about to bounce — the reload will be
  seamless, but say what you're doing).
- Test-edit page.html freely (auto-reload makes rollout instant); for
  server.js changes, keep a `web/server.js.bak` copy until the health curl
  passes.

## Scroll anchoring (page.html — v9 erg 95, 2026-07-26; history v2→…→v9)

**v9 (erg 95) — THE v7/v8 "I don't see the highlight" root cause:** Chromium
gives closed `<details>` content `content-visibility:hidden`, which still
LAYS OUT — so hidden `#inputs` cards had `getBoundingClientRect().height>0`,
came first in document order, and stole the anchor whenever input/ had
files: line on, gold painted on an invisible card, visible card bare. The
`r.height>0` filter did NOT catch them (the erg-87 note below claiming it
skips closed-details cards was WRONG). Fix: `anchorCapture` also requires
`el.checkVisibility()` (false under content-visibility:hidden, Chrome 105+;
fallback `!el.closest('details:not([open])')`). Keep this filter.
v8 (erg 92): `.reading` uses THREE paint channels (border, 2px outline,
warm bg tint #1a1812) + `pv·xxxxxx` badge in the erg panel = live page ver.

**Headless screenshot verification (erg 95 — USE THIS for paint bugs):**
`chromium` (apt-installed) + `python3-pil` are on the box.
`K=$(cat web/key.txt) && chromium --headless=new --no-sandbox --disable-gpu
--ignore-certificate-errors --hide-scrollbars --window-size=1440,2200
--virtual-time-budget=12000 --screenshot=/tmp/x.png
"https://localhost:{{PORT}}/#k=$K"` — tall viewport puts the ⅓-mark on cards
(headless can't scroll); `--dump-dom` variant shows final DOM classes.
Static fake-DOM harnesses can't catch layout/paint issues like v9's — the
screenshot can, and PIL pixel checks make it exact.

## (superseded history v2→v6 below)

v6 (erg 87): `#anchorline` has `z-index:-1` — it paints BEHIND cards/log/
header (the operator 15:25 "gold bar over (not under) the cards"), visible only in
background gaps at the 1/3 point; the `.reading` glow marks the card itself.
Don't raise the z-index back.

⚠ v5 (erg 85): the gold line is CSS-fixed at 1/3 again and JS never sets
`line.style.top`. v4 (erg 85's predecessor, same day) drew it under the
anchor card's bottom edge — the operator reported it "flowing with the scroll"
(15:17Z); their 15:06 "beneath the card" meant the mark should stay put, so
v5 reverted the line while keeping v4's fixes (scrollY<8 guard removal,
.reading glow on the anchor card, hide-when-inactive). Harness =
work/web/anchor-v4-harness.js (11 cases, rerun after ANY anchor edit; cases
4–5 assert JS does NOT touch line.style.top). Offered variant if slicing
through the card bothers the operator: paint line behind cards via z-index.


Re-renders (new/reordered cards) must not move what the operator is READING.
`anchorCapture()` before innerHTML swap / `anchorRestore()` after:
- Anchor = the card under the **READING MARK at 1/3 viewport height**
  (`anchorY()` = innerHeight/3; v2's viewport-top pick was wrong per the operator's
  14:55Z report). A fixed thin gold line `#anchorline` (CSS `top:33.333vh` —
  MUST stay in sync with `anchorY()`) marks the point; it gets class `.off`
  (dimmed) when no anchor is active.
- The anchor card is highlighted with class `.reading` (gold border+glow) by
  `anchorMark()`, called on scroll/resize (rAF-throttled), at end of
  refresh(), and at end of renderOutputs().
- Mark in static content (header/log/form, no card spanning it) → capture
  returns null, no adjustment; new cards grow below.
- Returns anchor + up-to-2 fallbacks so an archived-away anchor card falls
  through to the next; invisible cards skipped via checkVisibility() (v9 —
  closed `<details>` cards are NOT zero-height in Chromium, see top).
- Reply-box focus restore uses `focus({preventScroll:true})`.
Tested via fake-DOM node harness (11 cases, erg-80; erg-75 pattern): extract
the anchorY→anchorMark slice by regex, stub document/scrollY/innerHeight/
scrollBy/CSS/$, `new Function(...)`.

## Reactive cards (page.html renderOutputs — erg 77, 2026-07-25)

the operator's 14:37Z report: reply-box drafts wiped when new cards arrive. Fix =
per-card reconciliation, NO wholesale innerHTML of #outputs:
- Cards keyed by `data-name`; `data-sig` = [mtime, imp, urg, hot, rawToggle,
  report, sigHash(text)]. Unchanged sig → node untouched (draft/cursor/undo/
  focus survive natively). Changed sig → rebuild meta+body only, the live
  `<form.reply>` node is `appendChild`-ed back over (never recreated).
- Reorder via insertBefore (node move keeps value; move BLURS focus → focus +
  selectionStart/End captured before, restored after with preventScroll).
- Drafts ALSO persist to sessionStorage (`{{AGENT_NAME}}draft:<name>`, `#main` for the
  give-work box) on every input — survives ver-flip reloads (the actual
  likely wiper: any page.html edit reloads all tabs; old code only stashed
  scroll). Cleared on send; archive-with-draft = deliberate discard.
- Placeholders ('…'/'(nothing unread)') are non-card childNodes — the
  reconciler sweeps them each pass; empty list → box.textContent.
- Handler wiring (mdt/onsubmit/onkeydown/oninput) re-assigned idempotently
  every render on all cards.
- GOTCHA if editing card HTML: any change to meta/body markup must keep the
  form as the LAST child and `data-name`/`data-sig` on the card div; sig
  fields must cover everything rendered outside the form.

## Markdown renderer gotchas (page.html mdInline — erg 60, 2026-07-25)

- The client-side markdown is homegrown regex; ORDER MATTERS: esc → code-span
  stash → linkRep → stash <a> tags (formatting their inner text with fmt) →
  fmt on the rest → unstash loop (loops because anchors can nest code-span
  placeholders).
- NEVER let bold/em/del regexes see inside a rendered <a>: a `**` swallowed
  into an href let `</strong>` get spliced inside the tag → mangled attribute
  → unclosed <strong> that bled bold into ALL later cards + buttons (the operator
  report, fixed erg 60). Bare-URL linkifier also trims trailing `*` now.
- Quick regression test (node, run from web/): extract `const esc =` …
  `// blocks:` slice from page.html, `new Function(code+"; return mdInline;")()`,
  assert <strong> open/close counts match and no \x00 remains. Cases used
  erg 60: bold-wrapping-bare-URL, [**bold**](url), `co**de`, stray **, tails.
