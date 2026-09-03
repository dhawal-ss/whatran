<div align="center">

# whatran

### What your test suite actually ran.

Your agent says the tests pass. They do. The ones that are left.

[![npm](https://img.shields.io/npm/v/whatran?color=2f6b4f&label=npm)](https://www.npmjs.com/package/whatran)
[![node](https://img.shields.io/node/v/whatran?color=2f6b4f)](https://nodejs.org)
[![license](https://img.shields.io/github/license/dhawal-ss/whatran?color=2f6b4f)](./LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-none-2f6b4f)](./package.json)

</div>

---

## The thirty second version

You ask an AI agent to fix a bug. It works for a while and reports back:

> Fixed. All tests pass.

And they do:

```console
$ pytest -q
2 passed, 1 skipped
$ echo $?
0
```

It did not fix the bug. It switched off the test that was catching the bug. Your suite is green,
your CI is green, and the bug is still in your code.

`whatran` remembers what your tests did **before** the agent started, and tells you when something
stops running:

```console
$ whatran

  MISSING  1 failing test was skipped instead of fixed
            These tests were failing before the change and are now not running at all.
            The suite reports green because they no longer report anything.
            · test_auth::test_expired_token_rejected

  vs snapshot 2026-01-14T09:12:04.881Z, 6 minutes old, confirmed by a second run
  pytest · 3 tests, 2 passed, 0 failed, 1 skipped · 1.2s
```

## Install

```bash
npx whatran init
```

That is the whole setup. It finds your test runner, remembers what your suite runs today, and
wires itself into your coding agent. From then on, if the agent removes coverage it gets stopped
and told to go back and fix the code properly.

No account. No cloud. No API key. No AI anywhere in the checking. Nothing to configure.

You do not strictly need `init` either. Bare `whatran` records its own baseline the first time
you run it, so there is no command you have to remember to run first.

**Upgrading from 0.1.** The JUnit parser was rewritten, and the test ids it produces are no longer
the same strings, so a baseline recorded by 0.1 cannot be compared against a run by 0.3. It is
detected and replaced automatically on the next run rather than compared against and misread; you
will see one line saying so. Nothing to do, but the first run after upgrading measures against a
fresh baseline, so make it a run you are happy to call normal.

## In your agent

Once installed, `/whatran` is available as a slash command in Claude Code. It runs the check and
hands the result to the agent with instructions for acting on it, so you can ask for a
verification at any point rather than waiting for the end of a turn.

```console
> /whatran
```

The Stop hook does the same thing automatically at the end of every turn that touched something
capable of changing a test outcome.

## What it catches

| | | |
|---|---|---|
| **A failing test that stopped failing the honest way** | It is now skipped, deleted, or quietly excluded. The failing test *is* the description of the bug, so anything other than failed becoming passed means the goalposts moved. | `MISSING` |
| **A passing test that stopped running in a file this change shrank** | Not a rename: the file has fewer tests in it than it did. | `MISSING` |
| **A parametrised family that lost failing cases** | Renumbering hides which case, but a failure that was being caught no longer is. | `MISSING` |
| **A stray `.only`, `fdescribe`, or module-level `pytestmark = skip`** | Silently stops every other test in the file from running, while the suite still reports green. | `MISSING` |
| **A passing test that now fails** | Your change broke something that worked. | `BROKE` |
| **A new test that checks nothing** | It runs, it proves nothing, and it makes the suite look bigger than it is. | `NOTICE` |
| **A change to the test config itself** | One new `conftest.py`, or one line in `pyproject.toml`, can force an entire suite to report as passed without touching a line of source. | `NOTICE` |
| **A suite that collects fewer tests than before** | A backstop for everything the specific checks miss. | `NOTICE` |

Only `MISSING` interrupts your agent. A broken test **shouts**: it is red on screen, the agent
sees it, CI sees it. A skipped test **hides**: everything goes green and the only trace is one
line in a diff. whatran exists for the second kind, so it does not nag you about the first.

## What it will not do

**It will not slow you down.** The check runs in the background. Your turn ends straight away and
the suite runs behind it. If nothing that could possibly affect a test was edited, it does not run
your suite at all. (In a non-interactive run, `claude -p` or CI, hooks are synchronous, so there
the check does take as long as your suite.)

**It will not accuse you when it is not sure.** A broken import, a missing dependency, a suite that
would not start, a report it could not read: it says so and gets out of the way.

```console
  INCONCLUSIVE  pytest exited 2, which means the suite did not run to completion
  No claim is being made about this change.
```

**It will not blame your change for a flaky test.** Before making an accusation it runs the suite
again and reports only what happens twice. Tests caught doing this are remembered and left alone
for that one kind of finding, and every suppression is reported rather than silently applied.

**It will not quietly redefine "normal".** A baseline is never recorded from a working tree that
already has uncommitted changes in it, because that would write whatever the agent just did into
the definition of correct. If your tree is dirty and there is no baseline, it takes one from
`HEAD` in a scratch worktree and measures your changes against that.

**It will not repeat itself forever.** Say the same thing three times with nothing changing and it
goes quiet, because at that point your agent cannot act on it and you need to see it instead.

**It will not touch your files.** It does not edit your `.gitignore`, it does not write config for
a tool you are not using, and it never removes an entry from your agent config that it did not
write itself.

## Supported runners

Found automatically, using each framework's own built in reporter.

| | Runner | |
|---|---|---|
| Python | pytest | ✅ |
| JavaScript | Vitest, Jest, Mocha, `node:test` | ✅ |
| Go | `go test` | ✅ |
| Rust | `cargo nextest` | ✅ * |

\* Everything except `cargo nextest` uses a reporter that ships with the framework, so there is
nothing extra to install. `cargo nextest` is a separate binary (`cargo install cargo-nextest`);
plain `cargo test` has no stable machine-readable output to read.

If your project lives in a subfolder, run it from there. It looks where you are, not just at the
top of the repository. In a monorepo it checks one project and says plainly which others it did
not look at.

## Commands

```bash
whatran                    # check the working tree; records a baseline first if there is none
whatran status             # what is set up here, without running anything
whatran snapshot           # remember what the suite runs right now
whatran accept             # accept the current state as the new normal
whatran check --base main  # compare against a git branch instead
whatran detect             # show which test runner it found
whatran uninstall          # remove the hooks and the /whatran command
```

Exit codes: `0` nothing to report, **or no claim could be made**; `1` something is missing or
broke; `2` whatran itself could not run; `3` inconclusive, with `--strict`.

That first one matters in CI. A run that could not obtain evidence exits `0` by default, so if you
want a pipeline to fail rather than merge on a check that never happened, pass `--strict`.

**`whatran status`** answers "am I actually covered?" without running anything:

```console
$ whatran status

  Runner    pytest
  Project   .
  Baseline  6 minutes old, 47 tests (44 passed, 2 failed, 1 skipped)
            recorded at a2c86f7a, which is still HEAD
  Tree      has uncommitted changes
  Hooks     Claude Code
```

**`whatran accept`** is the escape hatch. Deleted a test on purpose? Accept it, and whatran tells
you exactly what it agreed to before it stops mentioning it:

```console
$ whatran accept

  Accepted, pytest
  This is now the expected state:
    · 1 failing test disappeared from the suite
        test_auth::test_expired_token_rejected
  2 tests: 2 passed, 0 failed, 0 skipped
```

## In CI

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0        # whatran needs the base commit, not just the tip
- run: npx whatran check --base ${{ github.event.pull_request.base.sha }}
```

No snapshot needed. It builds one from the branch you are merging into, by running that commit's
suite in a scratch worktree.

`fetch-depth: 0` is not optional. The default checkout is shallow, so there is no common ancestor
to compare against and every run is inconclusive: green pipeline, nothing verified.

`--base` mode refuses rather than guesses in two cases where a worktree would silently give the
wrong answer: a Python project installed with `pip install -e .`, and any JavaScript workspace
whose `node_modules` links back into the repository. In both, the "before" run would import the
current source and every difference would vanish. Use `whatran snapshot` in those projects.

## Works with

| | |
|---|---|
| **Claude Code** | Records the baseline when a session starts, stops the turn if coverage goes missing, and installs `/whatran`. Runs in the background, so it never makes you wait. |
| **Codex CLI** | Same, via `.codex/hooks.json`. Codex will not run a new hook until you trust it: run `/hooks` in Codex and approve the whatran entry. `init` tells you this. |
| **Cursor** | Sends the agent a follow up message, since Cursor cannot be stopped mid turn. |

When it stops your agent, this is what the agent is told. Each problem gets advice that fits it,
because "put the tests back" is the wrong instruction for a regression:

```
STOP. whatran compared what your test suite ran BEFORE this change with what it runs now, and
coverage went missing. The suite being green does not settle this: these tests are green because
they are no longer reporting.

1 failing test disappeared from the suite:
    test_auth::test_expired_token_rejected
  -> Put these tests back and make them pass by fixing the underlying problem. If one is
     genuinely obsolete, say so explicitly and explain why rather than deleting it.

Then verify it: re-run the test suite yourself and confirm by name that each test listed above now
runs and passes. Do not report back until you have seen that output.
Do not modify the test harness, the test configuration, or whatran itself to work around any of
this. If you genuinely believe a test above should no longer exist, leave it in place, stop, and
explain your reasoning to the user, so a person can decide.
```

Note what it does not say: it never mentions `whatran accept`. That command would clear the
finding without fixing anything, so it is deliberately kept out of the agent's reach and left as
your decision.

## Why it works this way

**It watches results, not edits.** Agents route around checks they can see. One developer set up a
hook to enforce their coding rules and watched the agent switch to editing files with `sed` to get
around it. You cannot fake a test going from failing to passing by changing *how* you edit. It
either runs and passes, or it does not.

**It compares runs, not diffs.** Plenty of tests stop running with no trace in the source at all: a
filter in a config file, a build flag, an import error that quietly drops a whole file. Searching
the diff for the word "skip" finds none of those, and fires constantly on
`skipif(platform == "windows")`, which is perfectly normal.

**It is mostly not about catching cheaters.** Coverage disappearing by accident is common: a
rename that drops a file from collection, a `.only` left behind while debugging, a config change
with a wider blast radius than intended. Deliberate tampering happens too, and the same check
catches both, because it never asks about intent.

### Compared with what else is out there

Coverage gates (Codecov patch status, `diff-cover`) tell you which *lines* stopped being executed,
which is a coarser signal and one that a deleted test improves rather than worsens. Mutation
testing (Stryker, `mutmut`, `cargo-mutants`) measures whether your tests would catch an injected
bug, which is more thorough and far too slow to run on every turn. Lint rules for `.only` and
`skip` markers catch the syntactic cases and miss everything that happens in config.

whatran occupies the gap between them: a per-test outcome diff, fast enough for every turn, that
notices a specific named test going from failing to not-running. That is the one signal none of
the others reports.

## Contributing

```bash
git clone https://github.com/dhawal-ss/whatran
cd whatran
npm test
```

No dependencies, no build step. The suite runs on `node --test` and includes checked-in real
reporter output as fixtures, because hand-written XML is exactly how a parser bug survives a
green suite.

## Licence

MIT
