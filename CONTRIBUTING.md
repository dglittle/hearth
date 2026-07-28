# contributing to hearth

**The rule: commit it only if it would help an agent who isn't you.**

That single line decides everything. Ports of a feature between siblings
(a new watch-page endpoint, a fix to the erg loop, a sharper phrasing of the
output conventions) belong here. Your domain knowledge, your stream cursors,
your ticket notes, your live state never do.

## In / out

**IN (heritable):** `erg.js`, `ro-erg.js`, `web/` (server + watch page),
`tools/`, the generic mind files (erg cycle, covenants, thread protocol,
output granularity + priority), generic playbooks like
`long-term/web-server-ops.md`, and the empty-but-structured skeleton
(`short-term/`, `long-term/index.md`, `input/`, `output/`, `ro/`).

**OUT:** anything domain-specific (your purpose lines, your standing threads,
your employer's systems), all live state (`short-term/*`, `ergs/`,
`ergs.jsonl`, `erg.log`, `input/`+`output/` contents, `tok-pref.json`), and
**every secret** (`secrets/`, `web/key.txt`, tokens, certs) — those are
`.gitignore`d and get a `.example` stub instead. A new agent = clone + a
domain briefing.

Per-agent divergence lives in each agent's own working copy, not in branches
that never merge.

## Committing back from a born agent

A born agent's checkout has had its placeholders substituted, so a straight
`git diff` is full of noise (its own name, port, dir). Two honest ways to
push a generic improvement up:

1. **Preferred:** make the change in a fresh `hearth` clone (placeholders
   intact), test it in your own dir, commit from the clone.
2. **Quick:** copy the changed file into a fresh clone and re-insert the
   placeholders before committing:

       sed -i -e "s|$PWD|{{AGENT_DIR}}|g" -e 's|<myname>|{{AGENT_NAME}}|g' \
              -e 's|<myport>|{{PORT}}|g' -e 's|<myhost>|{{HOST}}|g' file

   then `grep -n '{{' file` to check every knob came back.

Known rough edge: this placeholder round-trip is friction. Per-HOST values
(CLI path, token file, TLS certs) already live in a gitignored `host.conf`;
if the per-AGENT placeholders bite too, the same move applies to them.

## Style

Same as the agents themselves: small chunks, blunt comments that say *why*,
no dependencies (plain node, no npm), and nothing in a commit that a
stranger's agent would have to un-learn.
