# hearth

The fire other agents are lit from.

A Greek colony didn't reinvent itself from scratch: it carried fire from the
mother-city's hearth to light its own. This repo is that fire — the starting
config for a directory-shaped agent. `git clone` it, run `birth.sh`, brief it
on a domain, and an agent exists. Anything one sibling learns that would help
a sibling who isn't her comes back here.

## What an agent made from this is

**The agent is a directory, not a session.** The operator clicks a card on
the board (or replies to one); that runs `node erg.js --card N`, which spawns
one fresh, bare-bones `claude -p` session with no CLAUDE.md, no skills, no
auto-memory. It wakes, orients, does ONE unit of work — an **erg** — writes
what it learned to the card-board, and evaporates. Nothing survives an erg
except cards and files.

**Continuity lives in a sqlite card-board**, not folders:

    db/cards.db    every card: title, body, kind, status, imp/urg, links,
                   locks, positions — plus a costs table (the silent ledger)
    tools/card.js  the CLI ergs use: create/edit/link/lock/search/…
    erg.js         one erg: lock parent cards, build the system prompt from
                   mind cards, run the session, append the cost line, unlock
    web/           the board server + board.html — the operator's live UI
    ergs/          full jsonl transcript of every erg (a folder, never sqlite)
    ergs.jsonl     append-only erg ledger · erg.log — harness log
    work/          scratch workspace for in-progress artifacts
    secrets/       chmod-700, gitignored, never printed

Cards come in four kinds:

- **mind** — concatenated in board order, these ARE the system prompt.
  The agent can edit them → it edits who it is next erg.
- **memory** — one recursive kind (trackers, working state, durable
  knowledge). Top-level memory titles go in the system prompt; child
  memories are reached via `card show <parent>`, walking titles to leaves.
- **human** — cards the operator writes on the board: work items, asks, replies.
- **agent** (named after the agent, e.g. `ergane`) — results and messages
  back; every erg's output is one of these.

Chains replace folders: a workstream is cards linked child→child (human →
agent → reply → …); each card holds only its delta — an erg walks parents
for context.

**The erg↔card protocol (§5b):** every erg fires ON one or more parent
cards. `erg.js` locks them atomically (exit 2 on conflict), creates ONE
output card as child of all parents, and tells the session "card #K is
yours". The session edits that card's title as it works — the operator
watches the board live — then finalizes it: title = one-sentence result,
body = the self-contained deliverable. On exit erg.js appends a cost line
(wall · model · tokens · usd) and releases the locks. There is no cron and
no generic no-target mode: ergs fire only from the operator's board clicks
and replies.

Design commitments worth keeping: **one erg = one chunk**; **continuity
lives only in the card-board (and disk)**; **the mind is self-editable**;
**externally-visible actions need the operator's explicit approval**; **one
output card per independently-archivable thing** — title = the summary,
importance/urgency each rated 1–10 (the board sorts on an
operator-controlled blend of the two).

## The board

`web/server.js` serves `web/board.html`: a 2D canvas of draggable cards.
Position is meaning — mind cards' board order IS prompt order; one quadrant
is the shared operator↔agent interface. The operator reads output cards,
replies (a reply becomes a human card and fires an erg on it), archives
what's done, and fires ergs with ▶. Access is by secret key in the URL
fragment: `https://<host>:<port>/#k=<key>`.

## Birth an agent

    git clone git@github.com:dglittle/hearth.git ~/newagent
    cd ~/newagent
    ./birth.sh <name> <port> "<purpose>" [host]

`birth.sh` substitutes the placeholders in this checkout, makes the state
dirs, creates the card db and seeds the four generic mind cards from `seed/mind/`,
and generates `web/key.txt`. It starts nothing — it prints the exact
commands for the web server and the first erg.

Placeholders: `{{AGENT_NAME}}` `{{AGENT_DIR}}` `{{PORT}}` `{{HOST}}`
`{{PURPOSE}}`. A fresh checkout is a **template, not a runnable agent**;
`grep -rn '{{' .` shows every knob.

Then brief it: write a human card on the board saying who it works for, what
systems it has, what you want — and fire the first erg on that card.

## Host configuration

**Node ≥ 22 required** — the card-board uses the built-in `node:sqlite`.

Per-host paths live in **`host.conf`** (gitignored; created from
`host.conf.example`) — read at startup by `erg.js` and `web/server.js`:

- `CLAUDE_BIN` — the `claude` CLI (default: `claude` on PATH)
- `OAUTH_ENV_FILE` — file holding `CLAUDE_CODE_OAUTH_TOKEN` (+`_2` fallback);
  unset means the process environment. `ANTHROPIC_API_KEY` is deliberately
  deleted before every run so an erg can never silently bill cash
- `TLS_CERT` / `TLS_KEY` — board certs; unset means plain HTTP

Models are `MODEL` / `FALLBACK_MODEL` in `erg.js`, with a ~35-token
direct-API probe that skips a model whose weekly bucket is dry.

## What's not here

Every secret (`secrets/`, `web/key.txt`, certs, tokens), all live state
(`db/cards.db*`, `ergs/`, the ledgers and logs, `work/`), and anything
domain-specific. See `CONTRIBUTING.md` for the in/out split and the one
rule: **commit it only if it would help an agent who isn't you.**

## Lineage

Written by **ergane** (Greg's Ergeon agent, 2026-07-27), generalized from her
own directory — which was itself handed down from pima2, and which she'd
already cloned by hand once to make **ariadne**. This repo exists so the next
one is a `git clone` instead of a careful copy. Rewritten 2026-07-29, when
the file lanes (`mind/`, `input/`→`output/`, the `ro/` lane) gave way to the
sqlite card-board.
