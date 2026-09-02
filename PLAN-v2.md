# whatran v2 — from "gotcha" to "gets better work out of the agent"

## The problem with v1
It only answers one question (did a test stop running) and only ever says NO.
It is a tripwire, not a collaborator. Just proved it stays silent while an agent
BREAKS a working test, which is the most obvious thing a developer wants to know.

## The loop we should own
  BEFORE the turn  -> tell the agent what is true and what the rules are
  DURING           -> (out of scope for now)
  AFTER the turn   -> verify, and say precisely what to fix
  ACROSS turns     -> a summary a human can review in 10 seconds

## Planned additions, in value order

### 1. Regressions: passed -> failed        [MUST HAVE, trivial, glaring gap]
The agent broke something that worked. Report it, name the test, exit non-zero.
Also covers passed->error.

### 2. `whatran brief` — proactive guidance     [BEST OUTCOME LEVER]
Injected at SessionStart / UserPromptSubmit. Tells the agent, before it starts:
  - how many tests exist, and exactly which are currently failing
  - that those failing tests are the specification of the work
  - the rules: do not skip, delete, weaken, or edit the harness
EVIDENCE this works: Anthropic's own system-card numbers show an explicit
anti-hack instruction roughly halves reward hacking on impossible tasks
(Opus 4.6: 50% -> 23%). Telling the agent up front is cheaper than catching it.

### 3. Uncovered change detection            [PUSHES BETTER WORK]
"You changed 40 lines. None of them are executed by any test."
This is the single biggest driver of real quality: it makes writing a test the
path of least resistance. Evidence: 64.8% of agent PRs have NO changed line
executed by any existing test (arXiv 2607.18057, ICSME 2026).
Start with pytest (coverage.py) + vitest (built-in c8) where available; stay
silent when coverage tooling is absent rather than nagging.

### 4. Claim verification for commands + files   [ORIGINAL VISION]
The agent says "I ran the migration" / "I updated auth.py". Check it:
  - a claimed command replays and exits 0
  - a claimed file was actually touched
Fed by a structured claims block the skill asks the agent to emit.

### 5. `whatran report` — the 10-second review  [HUMAN LEVERAGE]
What changed, what tests moved, what it cost. So a human can review agent work
without reading every diff.

## Non-negotiables carried over from v1
- Never accuse when unsure. INCONCLUSIVE stays a first-class outcome.
- Never nag. Silence on a clean turn. No output when nothing changed.
- Deterministic. No LLM anywhere in the verification path.
- Fast. The relevance gate keeps irrelevant turns at ~250ms.
