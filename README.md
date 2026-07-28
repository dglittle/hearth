# hearth

The fire other agents are lit from.

A Greek colony didn't reinvent itself from scratch: it carried fire from the
mother-city's hearth to light its own. This repo is that fire — the starting
config for a directory-shaped agent. `git clone` it, run `birth.sh`, brief it
on a domain, and an agent exists. Anything one sibling learns that would help
a sibling who isn't her comes back here.

## What an agent made from this is

**The agent is a directory, not a session.** A cron/button fires
`node erg.js`; that spawns one fresh, bare-bones `claude -p` session with no
CLAUDE.md, no skills, no auto-memory. It wakes, orients, does ONE unit of
work — an **erg** — writes what it learned to disk, and evaporates. Nothing
survives an erg except files.

    mind/        system prompt = these files concatenated, each labeled.
                 The agent can edit them → it edits who it is next erg.
    short-term/  working memory; every erg's prompt lists each file's FIRST
                 LINE as its summary
    long-term/   the archive; not in the prompt, searched on demand,
                 indexed by long-term/index.md
    input/       work + messages in      output/  results + messages out
    ergs/        full transcript of every erg, auto-archived
    ro/          parallel READ-ONLY lane: an ask fires ro-erg.js alongside
                 the main lane and answers into ro/output/ only
    web/         the watch-page: erg.log live, output cards (priority-sorted,
                 reply/archive per card), an input box, an ask box, ▶ erg
    erg.js       the loop: lock, build system prompt, run, archive, ledger
    ro-erg.js    same, lockless + read-only deny-rules, for the ro lane

Design commitments worth keeping: **one erg = one chunk**; **continuity lives
only in files**; **the mind is self-editable**; **externally-visible actions
need the operator's explicit approval**; **one output file per independently-archivable
thing**, first line = summary, line 2 = `priority: importance=N urgency=N`.

## Birth an agent

    git clone git@github.com:dglittle/hearth.git ~/newagent
    cd ~/newagent
    ./birth.sh <name> <port> "<purpose>" [host]
    # e.g. ./birth.sh athena 8443 "the operator's work on the atlas project"

`birth.sh` substitutes the placeholders in this checkout, makes the state
dirs, and generates `web/key.txt`. It starts nothing — it prints the exact
commands for the web server, cron, and the first erg.

Placeholders: `{{AGENT_NAME}}` `{{AGENT_DIR}}` `{{PORT}}` `{{HOST}}`
`{{PURPOSE}}`. A fresh checkout is a **template, not a runnable agent**;
`grep -rn '{{' .` shows every knob.

Then brief it: drop a file in `input/` saying who it works for, what systems
it has, what you want. Its first ergs will write that into `long-term/`.

## Host configuration

Per-host paths live in **`host.conf`** (gitignored; `birth.sh` creates it
from `host.conf.example`) — read at startup by `erg.js`, `ro-erg.js` and
`web/server.js`:

- `CLAUDE_BIN` — the `claude` CLI (default: `claude` on PATH)
- `OAUTH_ENV_FILE` — file holding `CLAUDE_CODE_OAUTH_TOKEN` (+`_2` fallback);
  unset means the process environment. `ANTHROPIC_API_KEY` is deliberately
  deleted before every run so an erg can never silently bill cash
- `TLS_CERT` / `TLS_KEY` — watch-page certs; unset means plain HTTP

Models are `MODEL` / `FALLBACK_MODEL` in `erg.js`, with a ~35-token
direct-API probe that skips a model whose weekly bucket is dry. Ops manual
for the web server: `long-term/web-server-ops.md`.

## What's not here

Every secret (`secrets/`, `web/key.txt`, certs, tokens), all live state, and
anything domain-specific. See `CONTRIBUTING.md` for the in/out split and the
one rule: **commit it only if it would help an agent who isn't you.**

## Lineage

Written by **ergane** (Greg's Ergeon agent, 2026-07-27), generalized from her
own directory — which was itself handed down from pima2, and which she'd
already cloned by hand once to make **ariadne**. This repo exists so the next
one is a `git clone` instead of a careful copy.
