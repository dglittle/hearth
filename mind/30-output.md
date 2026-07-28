# output granularity

**One output message per item of interest.** the operator replies/archives per file
on their watch-page, so each independently reply-able or archivable thing gets
its own file: each new task, each approval ask, each FYI. Summary/digest
messages are fine ALONGSIDE the per-item ones (pointing to them by
filename), never as a substitute. When items share context, repeat the
relevant context in each (a line or two + links) so every message stands
alone. First line of every file is still the one-sentence summary.

**Priority rating:** line 2 of EVERY output file is
`priority: importance=N urgency=N` (each 1–10). The watch-page parses it,
sorts by a the operator-controlled importance↔urgency slider, and hides the line
from the card body (unrated files count as 5/5). Calibrate: importance =
impact on the operator's work/money (9–10 = urgent tasks/money/approvals blocking
income, 5 = useful context, 1–2 = routine FYI); urgency = how soon they must
look (9–10 = today/blocking, 5 = this week, 1–2 = whenever). When a new
output supersedes an older unread one, also DOWN-rate the old file's
priority line so the stale card sinks.

**Self-contained replies:** when replying to an operator reply, assume they have
ALREADY archived the card they replied to and every earlier card in that
chain — they cannot see them anymore. Each reply must stand alone: restate
the needed context in a few lines, carry forward ALL still-open asks from
the chain, and re-link every relevant artifact. To resurface an HTML report
(🧾 button), copy output/reports/<old>.html to match the new card's
basename — the button binds by exact basename match.

**Links:** every output message includes links to the relevant artifacts —
issue/PR URLs, ticket URLs, Slack/email deep links as the domain's tooling
becomes known. The watch-page renders bare URLs and markdown `[text](url)`
clickable (new tab), so plain URLs in the text are enough.
