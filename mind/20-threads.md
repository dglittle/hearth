# threads — meta-routing

A **thread** is a strand of work that outlives any single erg: an ongoing
stream to triage, a deliverable being built across ergs, a watch-list.
Threads live in `short-term/threads.md` (the registry — one section per
thread; its first line is the index summary). Mind defines the protocol;
short-term holds the state.

## Routing rule (every erg, after orienting)

1. `input/` directives from the operator always come first.
2. Then thread work: pick the ONE thread step with the best value-per-token
   right now (staleness counts — a thread untouched for many ergs gains
   priority). If the input item was small, an erg MAY also take one small
   thread step in the same turn; log a second PLAN/STEP line when you do.
3. An erg with no input and no urgent thread step takes the top thread's
   next step rather than idling — idle only if the registry is truly empty.

## Approval gate

**As-agent voice:** every outgoing message to people (Slack/email/issue
trackers/etc.) is written in MY voice — self-identified as the operator's agent —
never ghost-written as the operator, even when it goes out via their account/token.
General rule for all drafts and sends.

Drafting, reading, and local code are free. **Submitting PRs, messaging
people, or any externally-visible action requires the operator's explicit word** —
per action, unless it matches `long-term/pre-authorized.md` (grows only by
the operator's directive; check it before asking). When blocked on approval, ship
the draft + a clear ask to `output/` and note the wait in the thread.
