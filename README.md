# adjuster

<sub>npm: <code>adjuster-cli</code> · command: <code>adjuster</code></sub>

**Catches the test that stopped running.**

Your agent says the tests pass. They do — the ones that are left.

```
$ pytest -q
2 passed, 1 skipped     ← exit code 0. CI is green. The bug is still there.
```

`adjuster` compares what your test suite ran *before* the agent worked against what it runs
*now*, and tells you when coverage quietly went missing.

```
  DENIED   1 failing test was skipped instead of fixed
            These tests were failing before the change and are now not running at all.
            The suite reports green because they no longer report anything.
            · test_auth::test_expired_token_rejected

  pytest · 3 tests, 2 passed, 0 failed, 1 skipped · 1.2s
```

---

## Install

```bash
npx adjuster-cli init
```

That's it. It detects your test runner, records a baseline, and installs a hook so your coding
agent is stopped — and told to go back and fix it properly — the moment it removes coverage.

No account, no config file, no cloud, no LLM, no telemetry. Zero runtime dependencies.

## What it checks

| Check | What it catches |
|---|---|
| **Silenced failures** | A test that was **failing** before is now **skipped** or **gone**. The failing test is the specification of the bug — anything other than failed → passed means the specification moved. |
| **Harness tampering** | `conftest.py`, `pytest.ini`, `jest.config`, `.github/workflows/` and friends. A single new `conftest.py` can force an entire suite to report as passed without touching a line of source. |
| **Focus locks** | A stray `.only` / `fdescribe` / `fit` silently disables every other test in its file while the suite still reports green. |
| **Suite shrinkage** | A blunt backstop: fewer tests are collected than before, and nothing more specific explains it. |

## What it does *not* do

It does not accuse you when it isn't sure. If the suite fails to collect, if a dependency is
missing, if a worktree can't be built — it says **INCONCLUSIVE** and stays out of your way.

```
  INCONCLUSIVE  pytest exited 2, which means the suite did not run to completion
  No claim is being made about this change.
```

That distinction is the whole reason you can leave it switched on. A tool that cries wolf on a
broken import gets uninstalled the same afternoon.

It also never denies a **passing** test that becomes skipped. `@pytest.mark.skipif(sys.platform
== "win32")` is a legitimate guard, not a cover-up, and tools that grep diffs for skip markers
fire on every one of them.

## Supported runners

Auto-detected, using each framework's own built-in reporter — nothing to install.

| | Runner | How |
|---|---|---|
| Python | pytest | `--junit-xml` (built in) |
| JS/TS | Vitest, Jest, `node:test` | JSON / JUnit reporters (built in) |
| Go | `go test` | `-json` |
| Rust | `cargo nextest` | JUnit output |

Force one with `--runner <id>` if detection guesses wrong.

## Usage

```bash
npx adjuster-cli                 # check the working tree against the baseline
npx adjuster-cli snapshot        # record the current suite as the baseline
npx adjuster-cli check --base main   # CI mode: compare against a git ref instead
npx adjuster-cli detect          # show which runner would be used
npx adjuster-cli uninstall       # remove the hooks
```

Exit codes: `0` allowed or inconclusive, `1` denied, `2` flagged (with `--strict`).

### In CI

```yaml
- run: npx adjuster-cli check --base ${{ github.event.pull_request.base.sha }}
```

No baseline needed — it builds one from the ref in a detached worktree.

### With your agent

`npx adjuster-cli init` wires up whichever of these it finds:

- **Claude Code** — `SessionStart` records the baseline, `Stop` blocks the turn and hands the
  agent an instruction to restore the tests.
- **Codex CLI** — same, via `.codex/hooks.json`.
- **Cursor** — `stop` hook; Cursor can't block, so it re-prompts instead.

When it blocks, the agent receives this:

> Verification failed. Your change removed test coverage that existed before:
> - 1 failing test was skipped instead of fixed
>     `test_auth::test_expired_token_rejected`
>
> Restore these tests and make them pass by fixing the underlying problem. Do not skip, delete,
> or weaken them, and do not modify the test harness to work around this.

## Why it works this way

**It checks outcomes, not methods.** Agents route around checks they can see — one developer
reported an agent switching to editing files with `sed` to evade a hook. You cannot fake a
failed → passed transition by changing *how* you edit; the test either runs and passes or it
doesn't.

**It compares runs, not diffs.** A large class of skips leaves no trace in the source at all:
`--deselect`, `collect_ignore`, a `-k` filter in CI config, a build tag, an `assumeTrue` that
aborts at runtime, an import error that drops a whole file from collection. Only comparing what
actually executed catches those.

**It is not about catching cheaters.** Deliberate test tampering is rare and getting rarer.
Coverage disappearing by accident is not rare at all, and nothing else tells you when it happens.

## Development

```bash
npm test        # 30 unit tests, no dependencies
```

## Licence

MIT.

## Speed

The Stop hook runs on every turn, so it refuses to run your suite when nothing
could possibly have changed a test outcome — documentation, images, build
artefacts, agent config, or no edits at all.

On a repo whose suite takes 3.5s, that is the difference between **255ms** and
**3540ms** per turn. On a repo whose suite takes four minutes, it is the
difference between the tool being invisible and being uninstalled.

Everything unrecognised counts as relevant, so an unfamiliar file type causes a
check to run rather than to be silently skipped.
