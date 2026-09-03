<div align="center">

# whatran

### What your test suite actually ran.

Your agent says the tests pass. They do. The ones that are left.

[![npm](https://img.shields.io/npm/v/whatran?color=2f6b4f&label=npm)](https://www.npmjs.com/package/whatran)
[![node](https://img.shields.io/node/v/whatran?color=2f6b4f)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/whatran?color=2f6b4f)](./LICENSE)
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

## What it catches

| | | |
|---|---|---|
| **A failing test that stopped failing the honest way** | It is now skipped, deleted, or quietly excluded. The failing test *is* the description of the bug, so anything other than failed becoming passed means the goalposts moved. | `MISSING` |
| **A passing test that now fails** | Your change broke something that worked. | `BROKE` |
| **A new test that checks nothing** | It runs, it proves nothing, and it makes the suite look bigger than it is. | `NOTICE` |
| **A change to the test config itself** | One new `conftest.py` can force an entire suite to report as passed without touching a line of source. | `NOTICE` |
| **A stray `.only` or `fdescribe`** | Silently stops every other test in the file from running, while the suite still reports green. | `MISSING` |
| **A suite that collects fewer tests than before** | A backstop for everything the specific checks miss. | `NOTICE` |

Only `MISSING` interrupts your agent. A broken test **shouts**: it is red on screen, the agent
sees it, CI sees it. A skipped test **hides**: everything goes green and the only trace is one
line in a diff. whatran exists for the second kind, so it does not nag you about the first.

## What it will not do

**It will not slow you down.** The check runs in the background. Your turn ends straight away and
the suite runs behind it. If nothing that could possibly affect a test was edited, it does not run
your suite at all.

**It will not accuse you when it is not sure.** A broken import, a missing dependency, a suite that
would not start: it says so and gets out of the way.

```console
  INCONCLUSIVE  pytest exited 2, which means the suite did not run to completion
  No claim is being made about this change.
```

**It will not blame your change for a flaky test.** Before making an accusation it runs the suite
again and reports only what happens twice. And if nothing relevant was edited at all, an outcome
that moved is flakiness by definition. Tests caught doing this are remembered and left alone.

**It will not repeat itself forever.** Say the same thing three times with nothing changing and it
goes quiet, because at that point your agent cannot act on it and you need to see it instead.

**It will not touch your files.** It does not edit your `.gitignore`, and it does not write config
for a tool you are not using.

## Supported runners

Found automatically, using each framework's own built in reporter. There is nothing extra to
install.

| | Runner | |
|---|---|---|
| Python | pytest | ✅ |
| JavaScript | Vitest, Jest, `node:test` | ✅ |
| Go | `go test` | ✅ |
| Rust | `cargo nextest` | ✅ |

If your project lives in a subfolder, run it from there. It looks where you are, not just at the
top of the repository.

## Commands

```bash
whatran                    # check the working tree against what you remembered
whatran snapshot           # remember what the suite runs right now
whatran accept             # accept the current state as the new normal
whatran check --base main  # compare against a git branch instead
whatran detect             # show which test runner it found
whatran uninstall          # remove the hooks
```

Exit codes: `0` nothing to report, `1` something is missing or broke, `2` whatran itself could not
run.

**`whatran accept`** is the escape hatch. Deleted a test on purpose? Accept it, and whatran tells
you exactly what it agreed to before it stops mentioning it:

```console
$ whatran accept

  Accepted: pytest
  This is now the expected state:
    · 1 failing test disappeared from the suite
        test_auth::test_expired_token_rejected
  2 tests: 2 passed, 0 failed, 0 skipped
```

## In CI

```yaml
- run: npx whatran check --base ${{ github.event.pull_request.base.sha }}
```

No snapshot needed. It builds one from the branch you are merging into.

## Works with

| | |
|---|---|
| **Claude Code** | Records the baseline when a session starts, and stops the turn if coverage goes missing. Runs in the background, so it never makes you wait. |
| **Codex CLI** | Same, via `.codex/hooks.json`. |
| **Cursor** | Sends the agent a follow up message, since Cursor cannot be stopped mid turn. |

When it stops your agent, this is what the agent is told. Each problem gets advice that fits it,
because "put the tests back" is the wrong instruction for a regression:

```
whatran compared what your test suite ran before this change with what it runs now.

1 failing test was skipped instead of fixed:
    test_auth::test_expired_token_rejected
  -> Restore these tests and make them pass by fixing the underlying problem.
     Do not skip them. If one is genuinely obsolete, say so and explain why.

Do not modify the test harness to work around any of this.
```

## Why it works this way

**It watches results, not edits.** Agents route around checks they can see. One developer set up a
hook to enforce their coding rules and watched the agent switch to editing files with `sed` to get
around it. You cannot fake a test going from failing to passing by changing *how* you edit. It
either runs and passes, or it does not.

**It compares runs, not diffs.** Plenty of tests stop running with no trace in the source at all: a
filter in a config file, a build flag, an import error that quietly drops a whole file. Searching
the diff for the word "skip" finds none of those, and fires constantly on
`skipif(platform == "windows")`, which is perfectly normal.

**It is not really about catching cheaters.** Deliberate test tampering is rare and getting rarer.
Coverage disappearing by accident is not rare at all, and nothing else tells you when it happens.

## Contributing

```bash
git clone https://github.com/dhawal-ss/whatran
cd whatran
npm test
```

131 tests, no dependencies, no build step.

## Licence

MIT
