# whatran

**What your test suite actually ran.**

Your agent says the tests pass. They do. The ones that are left.

```
$ pytest -q
2 passed, 1 skipped     ← exit code 0. CI is green. The bug is still there.
```

`whatran` remembers what your suite ran *before* the agent started, and tells you when
something stops running.

```
  MISSING  1 failing test was skipped instead of fixed
            These tests were failing before the change and are now not running at all.
            The suite reports green because they no longer report anything.
            · test_auth::test_expired_token_rejected

  pytest · 3 tests, 2 passed, 0 failed, 1 skipped · 1.2s
```

---

## Install

> **Not published to npm yet.** Until it is, clone and run it directly:
>
> ```bash
> git clone <this-repo> && node whatran/bin/whatran.js init
> ```
> `init` writes an absolute path into the hook config, so it keeps working from a clone.

Once published:

```bash
npx whatran init
```

That's it. It finds your test runner, remembers the current state of your suite, and installs a
hook so your coding agent is stopped, and told to go back and fix it properly, the moment it
removes coverage.

No account, no config file, no cloud, no LLM, no telemetry. Zero runtime dependencies.

## What it looks for

| | | |
|---|---|---|
| **A failure that stopped failing the honest way** | A test that was **failing** before is now **skipped** or **gone**. The failing test is the specification of the bug, so anything other than failed → passed means the specification moved. | `MISSING` |
| **A regression** | A test that **passed** before now **fails**. Your change broke something that worked. | `BROKE` |
| **A test that checks nothing** | A test added by this change with no assertion in it. A test that runs but verifies nothing makes the suite look bigger while proving less. | `NOTICE` |
| **A moved goalpost** | `conftest.py`, `pytest.ini`, `jest.config`, `.github/workflows/`. A single new `conftest.py` can force an entire suite to report as passed without touching a line of source. | `NOTICE` |
| **A focus lock** | A stray `.only` / `fdescribe` / `fit` silently stops every other test in its file from running, while the suite still reports green. | `MISSING` |
| **A shrinking suite** | A blunt backstop: fewer tests collected than before, and nothing more specific explains it. | `NOTICE` |

### Why `MISSING` and `BROKE` are treated differently

A broken test **shouts**: it is red in the output, the agent sees it, CI sees it, nobody can miss
it. A silenced test **hides**: the suite goes green and the only trace is one line in a diff.

whatran exists for the second kind, so it only interrupts your agent mid-conversation for
`MISSING`. Blocking every turn where a test happens to be red would make it unusable during a
refactor. `BROKE` still fails `whatran check` and CI, and once whatran is interrupting for any
reason, it reports everything it found, because the agent is listening anyway.

## What it will not do

**It will not accuse you when it isn't sure.** If the suite fails to collect, if a dependency is
missing, if a worktree can't be built, it says so and stays out of your way.

```
  INCONCLUSIVE  pytest exited 2, which means the suite did not run to completion
  No claim is being made about this change.
```

That distinction is the whole reason you can leave it switched on. A tool that cries wolf on a
broken import gets uninstalled the same afternoon.

**It will not blame your change for a flaky test.** If an accusation is about to be made, the
suite runs a second time and only what happens twice is reported. And if nothing that could
affect a test was edited at all, an outcome that moved is flakiness by definition. No change,
no regression. Tests caught doing this are remembered and excluded from future accusations until
you next run `whatran accept` or `whatran snapshot`.

```
  NOTICE   1 test changed outcome with no relevant edit
            Nothing that could affect a test was touched, so this is flakiness or an
            order dependency rather than anything your change did.
```

The second run only happens when something was actually found, so a clean turn costs nothing.

**It will not flag a passing test that becomes skipped.**
`@pytest.mark.skipif(sys.platform == "win32")` is a legitimate guard, not a cover-up, and tools
that grep diffs for skip markers fire on every one of them.

## Supported runners

Found automatically, using each framework's own built-in reporter, so there is nothing extra to install.
If your project lives in a subfolder, run it from there; it looks where you are, not just at the
top of the repo.

| | Runner | How |
|---|---|---|
| Python | pytest | `--junit-xml` (built in) |
| JS/TS | Vitest, Jest, `node:test` | JSON / JUnit reporters (built in) |
| Go | `go test` | `-json` |
| Rust | `cargo nextest` | JUnit output |

When a repo has more than one, the runner named in the project's own test script wins over one
merely guessed at from a stray file. Override with `--runner <id>`.

## Usage

```bash
npx whatran                  # check the working tree against the remembered state
npx whatran snapshot         # remember the current suite
npx whatran accept           # accept the current state as the new normal
npx whatran check --base main    # CI mode: compare against a git ref instead
npx whatran detect           # show which runner would be used
npx whatran uninstall        # remove the hooks
```

Exit codes: `0` fine or inconclusive, `1` something is missing or broke, `2` notices only (with `--strict`).

**`whatran accept`** is the escape hatch. Deleted a genuinely obsolete test? Accept it, and
whatran says plainly what it just agreed to before it stops mentioning it:

```
  Accepted: pytest
  This is now the expected state:
    · 1 failing test disappeared from the suite
        test_auth::test_expired_token_rejected
  2 tests: 2 passed, 0 failed, 0 skipped
```

### In CI

```yaml
- run: npx whatran check --base ${{ github.event.pull_request.base.sha }}
```

No snapshot needed; it builds one from the ref in a detached worktree.

### With your agent

`npx whatran init` wires up whichever of these it finds:

- **Claude Code**: `SessionStart` remembers the suite, `Stop` blocks the turn and hands the agent
  an instruction to restore the tests.
- **Codex CLI**: same, via `.codex/hooks.json`.
- **Cursor**: `stop` hook; Cursor can't block, so it re-prompts instead.

When it blocks, the agent is told exactly what went wrong and what to do about *that particular
thing*, because "restore these tests" is the wrong advice for a regression:

```
whatran compared what your test suite ran before this change with what it runs now.

1 failing test was skipped instead of fixed:
    test_auth::test_expired_token_rejected
  -> Restore these tests and make them pass by fixing the underlying problem. Do not
     skip them. If one is genuinely obsolete, say so explicitly and explain why.

1 test that passed now fails:
    test_auth::test_token_has_user
  -> Your change broke these. Fix the code so they pass again. Do not edit the tests
     to match the new behaviour unless changing that behaviour was the point.

Do not modify the test harness to work around any of this.
```

## Why it works this way

**It watches outcomes, not edits.** Agents route around checks they can see. One developer
reported an agent switching to editing files with `sed` to evade a hook. You cannot fake a
failed → passed transition by changing *how* you edit; the test either runs and passes or it
doesn't.

**It compares runs, not diffs.** A large class of skips leaves no trace in the source at all:
`--deselect`, `collect_ignore`, a `-k` filter in CI config, a build tag, an `assumeTrue` that
aborts at runtime, an import error that quietly drops a whole file from collection. Only
comparing what actually executed catches those.

**It is not about catching cheaters.** Deliberate test tampering is rare and getting rarer.
Coverage disappearing by accident is not rare at all, and nothing else tells you when it happens.

## Speed

The agent hook runs on every turn, so it refuses to run your suite when nothing could possibly
have changed a test outcome: documentation, images, build artefacts, agent config, or no edits
at all.

On a repo whose suite takes 3.5s that is the difference between **255ms** and **3540ms** per
turn. On a repo whose suite takes four minutes it is the difference between the tool being
invisible and being uninstalled.

Anything unrecognised counts as relevant, so an unfamiliar file type causes a check to run rather
than be silently skipped.

## Development

```bash
npm test        # 108 unit and integration tests, no dependencies
```

## Licence

MIT.
