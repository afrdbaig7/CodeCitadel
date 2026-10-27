# Progress

Last updated: 2026-10-26

## Milestone: Phase 0 groundwork, R0 slice, R1 slices 1–8 (snapshots, diffs, impact, execution, comparison, accepted requirements, patch verification, reproduction + export, coupon demo, evidence export & replay)

Phase 0 asked for grounding: scope, stack, ADRs, threat model, parity plan, and
one runnable vertical slice. R1 asks for change analysis and local verification.
Eight slices exist: what a scan saw is stored and compared without guessing
(snapshots + diff); the changes are mapped through a TypeScript import graph to
the tests that can see them (impact); those tests can be executed in a
disposable copy of the tree with per-test results stored as evidence (run); two
stored run reports can be paired by test fingerprint into a before/after verdict
with spelled-out comparability gates (compare); and requirements are committed
declaratively, accepted explicitly with a digest over their text, and evaluated
against a stored run report (requirements); and a proposed patch is parsed
strictly, applied only inside a disposable copy, and judged against the
re-executed stored test selection with weakening detection (patch verify); and a
declared reproduction is executed in a disposable copy, classified from the
named test's actual result, and exported as an ordinary regression test with a
provenance manifest (reproduce run / reproduce export); and the end-to-end demo
orchestrates the full reproduction-to-fix flow against real PostgreSQL in a
disposable container (demo coupon-race); and evidence bundles package reports and
their artifacts into portable, tamper-evident archives replayed under strict
pre-execution integrity gates (evidence export / replay).
Nothing is executed unless `run`, `patch verify`, `reproduce run`, `demo`, or
`replay` is invoked.
`compare`, `requirements`, `reproduce export`, and `evidence export` read stored
files and touch no directory; `patch verify`, `reproduce run`, `demo`, and
`replay` write only inside a disposable copy, and export writes only where it was
told to.

### Implemented and verified

| Area | Evidence |
| --- | --- |
| Rust scanner: discovery with Git ignore rules, glob exclusions, hidden policy, sorted output | `cargo test --workspace` → 32 tests pass (30 unit + 2 protocol-fixture) |
| Bounded reads, SHA-256 digests, binary/UTF-8 skip reasons | `hashing.rs` tests (limit, at-limit, binary, UTF-16 probe) |
| Six `native-text` rules with metadata and redaction | `rules.rs` tests: detection, clean control, extension gating, per-line dedupe, per-file cap, emoji offsets |
| NDJSON protocol with `hello`/`file`/`finding`/`warning`/`summary`/`done`/`error` | `scan.rs` tests: ordering, fatal root, skipped counting, truncation, no secret in stream |
| Zod contracts for findings, protocol events, reports, snapshots, diffs, impact, execution | `packages/contracts/test` → 12 tests |
| Scanner client: explicit binary resolution, subprocess, record validation, timeout/cancel, record cap | `packages/scanner-client/test` → 21 tests |
| Report assembly: sorting, counts, mandatory limitations | `packages/core/test/report.test.ts` → 8 tests |
| Snapshot building: per-file digests, skip reasons, coverage options, determinism | `packages/core/test/snapshot.test.ts` → 3 tests |
| Change diff: added/modified/removed/unverified files, introduced/resolved/unverified findings, policy filter | `packages/core/test/snapshot.test.ts` → 9 tests |
| SARIF 2.1.0 renderer: five-level severity kept, redacted snippets withheld, fingerprints preserved | `apps/cli/test/sarif.test.ts` → 7 tests, CLI e2e, packed install |
| SARIF output checked against the published schema | one-off: `ajv` 8 + `https://json.schemastore.org/sarif-2.1.0.json`, `valid: true`. Not part of `pnpm test` (needs network for the schema) |
| Immutable snapshot files: schema-validated on read, write-once (`wx`) on write | `apps/cli/test/diff.e2e.test.ts` → 5 tests |
| TypeScript module graph: imports, re-exports, require, dynamic import; unresolved edges recorded | `packages/symbol-graph/test/graph.test.ts` → 9 tests |
| Impact analysis: backwards reachability, explained chains, completeness reasons | `packages/symbol-graph/test/impact.test.ts` → 10 tests |
| Shared change-analysis pipeline used by `impact` and `run` | `apps/cli/src/analyze.ts`; both e2e suites exercise it |
| Vitest adapter: validated JSON reporter output, per-test normalization, stable `t_…` IDs, bounded messages | `packages/executor/test/normalize.test.ts` → 13 tests |
| Disposable source copy: bounded (20 000 files / 256 MB), VCS/build/dependency directories skipped, `node_modules` linked back | `packages/executor/src/copy.ts`; CLI e2e asserts a test's marker file never reaches the checkout |
| Supervised run: shell-free argv, deadline with SIGTERM→SIGKILL, cancellation, 64 KiB output budget, allow-listed environment with explicit named forwarding (`--env`, values copied, names recorded) | `packages/executor/src/process.ts`, `packages/executor/test/process.test.ts`; CLI e2e timeout and forwarding cases |
| `run` outcomes kept separate: passed / failed / timed_out / cancelled / errored / unsupported / skipped | `run.e2e.test.ts` (7 tests spawning real Vitest, both isolation modes), contract enum, `packages/executor/src/record.ts` |
| Execution comparison: pairing by `t_…` fingerprint, ten-label grid, comparability gates, `identitySuspect` | `packages/core/src/compare-execution.ts` (13 unit tests), `packages/contracts/src/execution.ts` (`executionComparisonSchema`) |
| `codecitadel compare`: strict report reader, text + JSON rendering, exit codes 0/1/2 | `apps/cli/src/commands/compare.ts`, `compare.e2e.test.ts` (6 tests reading reports the real binary wrote) |
| Requirement document: strict schema v1, stable ids, registered checks, explicit acceptance with a digest over id/statement/checks | `packages/contracts/src/requirements.ts`, `packages/core/src/requirements.ts` |
| Acceptance staleness: digest recomputed on read; edited text is `stale`, not silently re-approved | `packages/core/test/requirements.test.ts` (15 tests: parse, acceptance, staleness, verdicts) |
| Requirement evaluation against a stored run: `met` / `unmet` / `inconclusive` / `not_accepted` | same suite; checks are paired through the shared `testFingerprint` |
| `codecitadel requirements list`, `accept`, `check` | `apps/cli/src/commands/requirements.ts`, `apps/cli/test/requirements.e2e.test.ts` (7 tests through the real binary) |
| Strict unified-diff parser and applier: absolute, `..`, backslash, quoted, and symlinked paths refused; binary, renames, and file-mode changes refused; exact context matching with no fuzz | `packages/executor/src/diff-parse.ts` (parser) and `packages/executor/src/patch.ts` (applier), `packages/executor/test/patch.test.ts` → 13 tests |
| Weakening inspection: file kinds (source/test/runner-config/lock/requirements/ignore), skip/`.only`/suppression signals, removed-vs-added assertion counting | `packages/core/src/patch-verification.ts`, `packages/core/test/patch-verification.test.ts` → 16 tests |
| Patch verdict in a fixed order: weakening and requirement regressions block `verified` before any outcome is consulted; inconclusive, not-applied, and incomparable pairs never claim a pass | `decidePatchVerdict`; CLI e2e asserts all four verdicts and exit codes 0/1/2 |
| `codecitadel patch verify`: gates → disposable copy → re-execution of the stored selection → comparison + requirement evaluation → versioned report, candidate checkout never written | `apps/cli/src/commands/patch.ts`, `apps/cli/src/render-patch.ts`, `apps/cli/test/patch.e2e.test.ts` (5 tests through the real binary) |
| Reproduction manifest and report contracts: strict v1 shapes, provenance, requirement link, check source + digest + byte count carried in the report | `packages/contracts/src/reproduction.ts`, `packages/contracts/test/reproduction.test.ts` → 9 tests |
| Reproduction verdict in a fixed order: requirement gate → nothing executed → run not finished → no result for the named test → `failed` is reproduced; a broken setup can never become evidence | `packages/core/src/reproduction.ts` (`decideReproductionVerdict`, `validateReproductionPath`), `packages/core/test/reproduction.test.ts` → 16 tests |
| `codecitadel reproduce run`: one declared check, executed in a disposable copy, classified from the named test's own result, gated on a current acceptance | `apps/cli/src/commands/reproduce.ts`, `apps/cli/src/render-reproduction.ts`, `apps/cli/test/reproduce.e2e.test.ts` (6 tests through the real binary) |
| `codecitadel reproduce export`: digest-verified report → test source at its original relative path + provenance manifest; refuses tampering, silent overwrite, and writing into the checkout without `--in-root` | same suite (5 tests, including running the exported file on its own with the project's Vitest) |
| CLI `scan` (JSON/Markdown/SARIF, policy exit codes), `diff`, `impact`, `run`, `compare`, `requirements`, `patch verify`, `reproduce run|export`, `demo coupon-race`, `evidence export`, `replay`, and `doctor` | `apps/cli/test` → 81 tests, most spawning the real binary |
| End-to-end demonstration (`codecitadel demo coupon-race`): starts/connects PostgreSQL, work copy, accepts requirement, runs baseline, reproduces concurrency race, verifies labeled patch, teardown | `apps/cli/test/demo.e2e.test.ts` (4 tests) + real Docker container execution (`DEMONSTRATED`) |
| Evidence bundle export (`codecitadel evidence export`): packages report + artifacts into tamper-evident container with per-file SHA-256 digests and permissions | `packages/contracts/test/evidence.test.ts` (4 tests), `apps/cli/test/evidence.e2e.test.ts` (5 tests) |
| Evidence bundle replay (`codecitadel replay`): strict pre-execution schema/digest/size/env checks, isolated re-execution in disposable copy, confirmed/diverged verdict | `packages/core/test/evidence.test.ts` (7 tests), `apps/cli/test/evidence.e2e.test.ts` (5 tests) |
| Prebuilt artifact in a per-platform package, checksum-verified on every launch | `scripts/package-scanner.mjs`, `resolve-binary.test.ts` → 11 tests including tamper, missing manifest, path escape |
| Packed install outside the monorepo with no Rust toolchain | `scripts/verify-pack.mjs` → 21 checks passing on win32-x64, 7 tarballs |
| Study documentation: index with reading paths, two flow chapters (scan, reproduce/export), four reviewed file pages, glossary, `coverage.json` inventory | `docs/study/`, `docs/study/coverage-report.md` — 4 of 110 first-party files reviewed, backlog stated |
| Documentation checker: inventory, local links, stale source hashes, self-test fixtures, strict mode for new files | `scripts/docs-check.mjs` (`pnpm docs:check`, `docs:check:strict`, `docs:self-test`) — 6 self-test cases detected |
| License and third-party attribution | `LICENSE` (Apache-2.0, verbatim), `NOTICE`, generated `THIRD-PARTY-NOTICES.md` |
| Cross-language contract guard | `fixtures/analysis/scanner-hello.ndjson` parsed by both suites |

### Commands run (actual results)

The Rust lines below are the last runs of the unchanged scanner crate. Nothing in
`crates/` was edited for slices 1–3, so `cargo test`, `clippy`, and `fmt` were not
re-run this turn.

```text
cargo test --workspace                     → 32 passed, 0 failed
cargo clippy --workspace --all-targets -D warnings → clean
cargo fmt --all --check                    → clean
pnpm typecheck                             → 11 tasks, clean
pnpm build                                 → 8 packages built
pnpm test                                  → 294 passed (31 + 21 + 19 + 34 + 87 + 12 + 9 + 81), 0 failed
node scripts/package-scanner.mjs           → win32-x64 artifact, sha256 recorded
node scripts/verify-pack.mjs               → 7 tarballs, 21 checks, all passing
node scripts/docs-check.mjs                → inventory, links, and stale hashes (see docs/study/coverage-report.md)
```

Observed CLI behaviour on this machine (Node 24.18.0, Rust 1.92.0, Windows 11
x64). The execution example is dogfooding: snapshot this repository, touch one
module, and run.

```text
$ node apps/cli/dist/index.js scan fixtures/security --fail-on none
scanned 5 file(s), skipped 0, found 5 finding(s) in 4ms (critical 0, high 2, medium 2)
# findings: 1 redacted AWS key (high), TLS verification off (high),
# dangerouslySetInnerHTML (medium), shell: true (medium), TODO (info)
# exit 0

$ node apps/cli/dist/index.js scan fixtures/security
# exit 1: 2 finding(s) at or above "high" breached the policy

$ node apps/cli/dist/index.js scan fixtures/security --fail-on none --save-snapshot /tmp/before.json
# exit 0; snapshot records 5 files with sha256 digests and 5 findings

$ node apps/cli/dist/index.js diff fixtures/security --base /tmp/before.json
files: 5 unchanged, +0 added, ~0 modified, -0 removed, ?0 unverified
findings: 0 introduced, 0 resolved, 0 unverified, 5 carried over
# exit 0 (diff only gates with --fail-on)

# after fixing the TLS override and adding a new `shell: true` call:
files: 4 unchanged, +1 added, ~1 modified, -0 removed, ?0 unverified
findings: 1 introduced, 1 resolved, 0 unverified, 4 carried over
  + medium   security/shell-enabled-subprocess  src/shell.js:2
  - high     security/tls-verification-disabled  src/tls.ts:2
# exit 1 with --fail-on medium, exit 0 without

$ node apps/cli/dist/index.js impact .codecitadel/work --base .codecitadel/impact-base.json
base 2026-10-22T06:31:16.560Z (…/fixtures/impact)
changed 1 file(s): modified src/math.ts
graph: 5 module(s), 4 edge(s), 2 test file(s); 2 external import(s), 0 outside scope, 0 unresolved

selected tests (1):
  src/math.test.ts → src/math.ts  [1 hop(s)]
not selected: 1 test file(s)
# exit 0; the sibling formatting test is not selected, and nothing was executed

$ node apps/cli/dist/index.js scan . --fail-on none --save-snapshot /tmp/root-snapshot.json
scanned 124 file(s), skipped 0, found 26 finding(s) in 225ms

# …touch packages/executor/src/vitest-report.ts, then:
$ node apps/cli/dist/index.js run . --base /tmp/root-snapshot.json
run run_e6f847668d25e309 → passed
  vitest 3.2.4 on node v24.18.0 (win32-x64)
  root D:\CodeCitadel
  isolation source-copy (linked from the checkout: apps/cli/node_modules, node_modules,
    packages/contracts/node_modules, packages/core/node_modules, packages/executor/node_modules, …)
  duration 1503ms, runner exit code 0

changed 1 file(s); selected 1 of 17 test file(s)
  modified packages/executor/src/vitest-report.ts

selected:
  packages/executor/test/normalize.test.ts → packages/executor/src/index.ts → src/vitest-report.ts  [2 hop(s)]

results: 13 passed, 0 failed, 0 skipped, 0 errored, 0 timed out, 0 cancelled, 0 unsupported
  PASSED      packages/executor/test/normalize.test.ts › boundMessage strips ANSI colour and keeps the first non-empty line  (0ms)
  … 12 more
# exit 0

# the same command against a subpackage whose tsconfig extends a file above it:
$ node apps/cli/dist/index.js run packages/executor --base /tmp/exec-snapshot.json
results: 0 passed, 0 failed, 0 skipped, 1 errored, 0 timed out, 0 cancelled, 0 unsupported
  ERRORED     test/normalize.test.ts › (suite)
    failed to resolve "extends":"../../tsconfig.base.json" in C:\…\codecitadel-copy-DWEn7M\tsconfig.json
# exit 2 — an environment problem is reported as errored, not as a passing or failing test

# dogfooding the before/after comparison: run twice against one base, break the code in between
$ node apps/cli/dist/index.js run . --base /tmp/root-snapshot.json --out /tmp/run-before.json --format json
# (passed; then change src so the selected test fails)
$ node apps/cli/dist/index.js run . --base /tmp/root-snapshot.json --out /tmp/run-after.json --format json

$ node apps/cli/dist/index.js compare --before /tmp/run-before.json --after /tmp/run-after.json
compare → comparable
  before 2026-10-23T05:39:04.748Z (passed) — vitest 3.2.4 on node v24.18.0 (win32-x64), root …\fix
  after  2026-10-23T05:39:06.769Z (failed) — vitest 3.2.4 on node v24.18.0 (win32-x64), root …\fix

outcome changes: 1 newly failing, 0 still failing, 0 fixed, … 0 gone, out of 1
  NEWLY FAILING  src/math.test.ts › add adds two numbers
    after:  AssertionError: expected -1 to be 5 // Object.is equality
# exit 1

# the same pair with the after report's runnerVersion edited to "9.9.9":
$ node apps/cli/dist/index.js compare --before /tmp/run-before.json --after /tmp/run-after-other-runner.json
compare → NOT COMPARABLE
reasons the pair must not be read as evidence:
  - The runs used different runner versions (3.2.4 and 9.9.9).
# exit 2 — the pairing is still printed, under the verdict

# accepted requirements, on a scratch copy of the fixture
$ cp -r fixtures/requirements /tmp/req
$ node apps/cli/dist/index.js requirements list /tmp/req
requirements → 2 requirement(s): 0 accepted, 0 stale, 2 proposed, 0 rejected

$ node apps/cli/dist/index.js requirements accept coupon.single-redemption /tmp/req --by afreed
accepted coupon.single-redemption by afreed
  digest sha256:d313ac1b5d88ebf657b1e59b223c5f82a59fd08740939d607bf0ac808fb7463f
  wrote  …\req\codecitadel.requirements.json

$ node apps/cli/dist/index.js requirements check /tmp/req --report /tmp/run-after.json
requirements → 1 met, 0 unmet, 0 inconclusive, 1 not accepted (out of 2)
  run run_0123456789abcdef generated 2026-10-23T00:00:00.000Z, root /repo

MET            coupon.single-redemption  [acceptance current]
  passed        src/coupon.test.ts › coupon > a user redeems a coupon once
  passed        src/coupon.test.ts › coupon > a repeated redemption is rejected

NOT ACCEPTED   token.expiry-boundary
  not_run       src/token.test.ts › token > rejects a token at its expiry instant  (no result)
# exit 0; the proposed requirement is listed on stderr and does not affect the code

# edit the accepted statement, then read it again:
$ node apps/cli/dist/index.js requirements list /tmp/req
stale: 1 requirement(s) changed after acceptance; accept the current text again or revert the edit
# exit 2 — the old approval is not carried over to the new words

# patch verification, dogfooding the fixture: snapshot, touch, run, then verify two patches
$ cp -r fixtures/execution /tmp/pv
$ node apps/cli/dist/index.js scan /tmp/pv/tree --scanner target/release/codecitadel-scanner.exe --fail-on none --save-snapshot /tmp/pv/snapshot.json
# exit 0, snapshot written
$ echo "// touched" >> /tmp/pv/tree/src/math.ts
$ node apps/cli/dist/index.js run /tmp/pv/tree --base /tmp/pv/snapshot.json --runner …\node_modules\vitest\vitest.mjs --format json --out /tmp/pv/before.json --timeout-ms 60000
passed: 1 passed, 0 failed, 0 skipped, 0 errored, 0 timed out, 0 cancelled (1 result(s) from 1 selected file(s) in 954ms, isolation source-copy)
# exit 0; before.json fixes the selection: src/math.test.ts

# a harmless patch (adds one comment line to src/math.ts):
$ node apps/cli/dist/index.js patch verify /tmp/pv/harmless.patch --before /tmp/pv/before.json --runner …\node_modules\vitest\vitest.mjs
patch verification → VERIFIED
  root C:\…\pv\tree
  patch sha256:bb8e775fead398… (1 file(s), +1/-0)
  runs passed → passed
  after vitest 3.2.4 on node v24.18.0 (win32-x64), isolation source-copy, 1005ms

reason: All 1 selected test result(s) passed after the patch, no test newly fails, and no weakening signal was found.

patch files (1)
  modified  source              src/math.ts (+1/-0)

comparison: 0 fixed, 0 newly failing, 0 still failing, 0 newly passing, 1 still passing, …

limitations
  - The patch was applied to a disposable copy under the OS temp directory, which was then copied again for execution. The checkout was never modified, and nothing was applied to it.
  - … 7 more stated limits, plus the "no requirement document" note when absent
# exit 0

# a breaking patch (return left - right):
$ node apps/cli/dist/index.js patch verify /tmp/pv/breaking.patch --before /tmp/pv/before.json --runner …
patch verification → NOT VERIFIED
reason: 1 test(s) that passed before the patch fail after it.
comparison: 0 fixed, 1 newly failing, 0 still failing, …
  newly failing       src/math.test.ts › add adds two numbers
    AssertionError: expected -1 to be 5 // Object.is equality
# exit 1 — the experiment ran and the patch loses

# a weakening patch (same line rewritten with a trailing `// @ts-ignore`):
$ node apps/cli/dist/index.js patch verify /tmp/pv/weakening.patch --before /tmp/pv/before.json --runner …
patch verification → NOT VERIFIED
signals (1)
  weakening suppressed-diagnostics src/math.ts:2
    adds a diagnostic suppression, which hides a compiler or lint error instead of resolving it.
not_verified: The patch carries 1 weakening signal(s) (suppressed-diagnostics);
  a patch cannot verify itself by removing or hiding the evidence.
# exit 1 — weaker evidence cannot earn the green verdict even though the copy's suite passed

# a stale patch (context line that was never in the tree):
$ node apps/cli/dist/index.js patch verify /tmp/pv/stale.patch --before /tmp/pv/before.json --runner …
patch verification → NOT APPLIED
reason: The patch did not apply: The patch does not match the file at old line 2:
  expected "  return left + right; // never written", found "  return left + right;". The patch is stale.
# exit 2 — refused before any test ran; the checkout is untouched either way

# a declared reproduction of a broken checkout (manifest + failing check):
$ node apps/cli/dist/index.js reproduce run /tmp/rp/reproductions.json /tmp/rp/tree --id math.negative-sum --runner …\node_modules\vitest\vitest.mjs --out /tmp/rp/report.json
reproduced: The named check failed against this tree, so the expected behavior does not hold under this check.
check reproductions/negative.test.ts › reproduction adds negative numbers (t_bf37f5a039805a04)
# exit 0 — the failure was observed, and the report records the runner and the result

$ node apps/cli/dist/index.js reproduce run … --id coupon.double-redemption …
not_accepted: The requirement "coupon.single-redemption" is proposed, not accepted, so this reproduction is not evidence for it.
# exit 2 — nothing was executed; the report records record: null

$ node apps/cli/dist/index.js reproduce export /tmp/rp/report.json --out /tmp/rp/export
reproduction export → math.negative-sum
  test D:\…\rp\export\reproductions\negative.test.ts
  manifest D:\…\rp\export\math.negative-sum.reproduction.json
  check reproductions/negative.test.ts › reproduction adds negative numbers
  evidence reproduced recorded 2026-10-25T07:09:15.131Z against D:\…\rp\tree
# exit 0; the exported test runs with the project's own Vitest and imports nothing from CodeCitadel

$ node apps/cli/dist/index.js scan fixtures/clean
# exit 0, 0 findings

$ node apps/cli/dist/index.js scan fixtures/security --save-snapshot /tmp/before.json
# exit 2: Refusing to overwrite the existing snapshot at /tmp/before.json
```

The CLI e2e suite adds the cases that are awkward to show by hand: a failing test
exits 1 with `failed` and the assertion message, a 1 ms deadline exits 2 with
`timed_out` and no results, a missing runner path exits 2 with an actionable
error, and a change no test can see exits 0 with `skipped` and `command: []`.
The `compare` e2e suite adds: a regression pair (pass → fail, exit 1), a repair
pair (fail → pass with the same change classification, exit 0 and `FIXED`), two
identical runs (`still passing`, exit 0), a mutated runner version (not
comparable, exit 2, pairing still shown), a mutated selection (not comparable),
and a snapshot passed in place of a run report (strict read rejection). The
`patch verify` e2e suite adds: a verified patch (~checkout byte-identical,
after run on the exact stored selection), a behavioural break (exit 1 with the
assertion message), a patch that skips the test it failed (executes, green, and
still `not_verified` because of the weakening signal), a stale patch refused
before execution (exit 2), and a patch that escapes the root or is not a diff
and is refused by the parser alone. The `reproduce` e2e suite adds: a reproduced
check with the runner facts recorded, a passing check (`not_reproduced`, exit 1),
a requirement accepted through the CLI before a reproduction counts, a proposed
requirement refused with `record: null` (exit 2), a name the runner never
reported (`inconclusive`), a manifest with an unknown field (exit 2), an export
whose exported file is then run alone in a fresh copy of the project and fails
with the original assertion, a silent overwrite refused, an in-root write
refused without `--in-root`, a report whose source was edited (`inconsistent`),
and an unreadable report.

`fixtures/security/node_modules/` is ignored and absent from the report, and
`AKIAIOSFODNN7EXAMPLE` never appears in any output.

### R1 slice 8A — coupon demo fixture (`examples/shopping-api`)

The R1 gate needs a real API to demonstrate against, so the fixture is a
standalone project (Fastify 5, `pg`, ordered SQL migrations, Vitest) installed
with npm inside `examples/shopping-api/`, not a workspace package: it is the
repository under analysis, not part of the engine. `redemptions` deliberately
has no unique constraint on `(user_id, coupon_id)`, and `redeemCoupon` checks and
then inserts in two statements, so concurrent requests both pass the check. The
labeled `CODECITADEL_DEMO_HOLD_MS` hook pauses between check and insert so the
interleaving is repeatable; it is a test hook, not evidence about production
frequency.

Run against PostgreSQL 16.15 in a disposable container
(`docker run -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine`):

```text
$ npm test                    → 3 passed (first redemption 201, repeat 409, unknown coupon 404, no userId 400)
$ npm run test:reproduction   → 1 failed, as intended: 8 accepted responses and 8 stored redemptions
$ npx tsc -p tsconfig.json --noEmit → clean
$ node src/main.ts            → listening on 127.0.0.1:3011; GET /health → 200 {"ok":true}
$ npm run migrate (twice)     → applied 001_init.sql, then "nothing to apply"
```

Each test run creates its own database (`cc_demo_<random>`), migrates it, and
drops it `with (force)`; no `cc_demo_*` database remained afterwards. The
concurrency check lives in `reproductions/` and is excluded from `npm test` on
purpose: it fails on this checkout, which is the claim under demonstration.

`--env <names>` (on `reproduce run`, and on `run` and `patch verify` from slice
8C) closes the gap between a check that needs a resource and a runner that must
not inherit the shell: the executor still starts from an
allow-list, and now copies named variables from the CLI's own process, up to 16,
refusing anything that is not a portable name and refusing names it always passes.
Only names are recorded — `Forwarded environment variables by name: …` is a runner
note in the report's limitations — and naming a variable that is not set is
refused before anything is copied (exit 2): running without it would turn a
connection failure into a `failed` check and therefore into a `reproduced`
verdict, which is exactly the broken-setup-as-evidence mistake the reproduction
rules forbid. Verified by `packages/executor/test/process.test.ts` (8 tests:
allow-list default, forwarding, unset name, dedupe, invalid name,
always-forwarded name, cap, no value in errors) and three CLI e2e cases: the same
check reports `not_reproduced` with `--env CODECITADEL_DEMO_DB_URL` and
`reproduced` without it, `--env not-a-name` exits 2, and a named but unset
variable exits 2 before execution.

Dogfooded against the real fixture: with the demo container running,
`codecitadel reproduce run /tmp/coupon.reproductions.json examples/shopping-api
--id coupon.concurrent-redemption --env CODECITADEL_DEMO_PG_URL` reached
PostgreSQL through the runner and reported `reproduced` (exit 0) with
`AssertionError: Expected one accepted redemption, observed 8 accepted response(s)
and 8 stored redemption(s)`. The same command with the variable unset exits 2
without copying the tree.

### R1 slice 8B — the coupon fixture answers to an accepted requirement

`examples/shopping-api/codecitadel.requirements.json` declares
`coupon.single-redemption` ("A coupon can be redeemed only once per user.") with
three checks: first use and repeated use in `test/coupon.test.ts`, and the
concurrent check in `reproductions/coupon-race.test.ts`. It was accepted through
the CLI, which recomputed the digest over id, statement, and checks:

```text
$ codecitadel requirements accept coupon.single-redemption examples/shopping-api --by afreed
accepted coupon.single-redemption by afreed
  digest sha256:b145f0b05b07d107…
  wrote  examples\shopping-api\codecitadel.requirements.json

$ codecitadel requirements list examples/shopping-api
requirements → 1 requirement(s): 1 accepted, 0 stale, 0 proposed, 0 rejected
coupon.single-redemption  [accepted by afreed at 2026-10-26T05:10:20.772Z]
  coupon-first-use       test/coupon.test.ts › coupon redemption a user redeems a coupon once  t_5ef57445f131c722
  coupon-repeated-use    test/coupon.test.ts › coupon redemption a repeated redemption is rejected  t_98ae5310e259f042
  coupon-concurrent-use  reproductions/coupon-race.test.ts › coupon concurrent redemptions by one user redeem the coupon once  t_b73bd648aba98ad5
```

`examples/shopping-api/codecitadel.reproductions.json` declares
`coupon.concurrent-redemption`, links it to that requirement, and names the check.
The run is gated on the acceptance and classifies only the named test's result:

```text
$ codecitadel reproduce run examples/shopping-api/codecitadel.reproductions.json \
    examples/shopping-api --id coupon.concurrent-redemption --env CODECITADEL_DEMO_PG_URL
reproduced: The named check failed against this tree, so the expected behavior
  does not hold under this check.
check reproductions/coupon-race.test.ts › coupon concurrent redemptions by one user
  redeem the coupon once (t_b73bd648aba98ad5)
# exit 0 — report: requirement {accepted, current}, record failed (vitest 3.2.4,
# exit 1, isolation source-copy), result failed with
# "Expected one accepted redemption, observed 8 accepted response(s) and 8 stored
#  redemption(s)", and the forwarded name recorded in limitations.
```

Editing the statement after acceptance and re-running exits 2 with `not_accepted`,
`acceptance: "stale"`, and `record: null`: the gate refuses before anything runs,
so a changed promise is not quietly measured against the old one. Restoring the
file returns the requirement to `current`. Both the report and the stale report
were written under `.codecitadel/` (ignored by git), so no evidence file is
committed, and the fixture's committed files are only the requirement document,
the reproduction manifest, the tests, and the app.

### R1 slice 8C — the labeled patch, verified against the reproduction

`examples/shopping-api/patches/0001-coupon-single-redemption.patch` is the
labeled deterministic repair, authored in advance rather than generated: a new
migration removes existing duplicates explicitly (keeping the earliest
redemption per user and coupon) and creates a unique index on
`redemptions (user_id, coupon_id)`, and `redeemCoupon` uses
`on conflict (user_id, coupon_id) do nothing`, answering "nothing was inserted"
the same way a repeated call is. `patch verify` now takes `--env`, so the
post-patch run can reach the demo database the way the before run did.

```text
$ codecitadel scan examples/shopping-api --save-snapshot .codecitadel/shop-base.json
$ codecitadel run examples/shopping-api --base .codecitadel/shop-base.json --env CODECITADEL_DEMO_PG_URL --out .codecitadel/shop-before.json
failed: 3 passed, 1 failed … (4 result(s) from 2 selected file(s) in 2782ms)
  failed  reproductions/coupon-race.test.ts › coupon concurrent redemptions by one user redeem the coupon once
  passed test/coupon.test.ts › coupon redemption a repeated redemption is rejected
  …
# exit 1 — the failing baseline, and the selection that re-execution is fixed to

$ codecitadel patch verify examples/shopping-api/patches/0001-coupon-single-redemption.patch \
    --before .codecitadel/shop-before.json --env CODECITADEL_DEMO_PG_URL
verified: All 3 selected test result(s) passed after the patch, no test newly fails,
  and no weakening signal was found.
patch sha256:23eeb20771753d… 2 file(s), +33/-9, 0 weakening signal(s)
# exit 0 — comparison: 1 fixed, 3 still passing, 0 newly failing; requirements:
# coupon.single-redemption met (it was unmet before the patch); after run passed.

# negative control: a patch that only rewrites the vulnerable doc comment
$ codecitadel patch verify .codecitadel/comment-only.patch --before .codecitadel/shop-before.json --env CODECITADEL_DEMO_PG_URL
not_verified: 1 test(s) failed before the patch and still fail after it; the patch
  does not resolve the failing evidence.
# exit 1 — the green verdict came from the constraint, not from the tool
```

The checkout was never patched: `patch verify` applied the diff inside a
disposable copy, and the fixture's own tests still pass afterwards with the race
still reproducible, because a proposal is not an apply. Two e2e cases cover the
new flag: `run` records the forwarded name (and never the value) in its report
limitations, and both `run` and `patch verify` exit 2 on an invalid name and on a
### R1 slice 8D — the one-command demo (`codecitadel demo coupon-race`)

`codecitadel demo coupon-race` orchestrates the complete verification flow in a
single command with six distinct, ordered acts:
1. Starts a disposable PostgreSQL 16 container (`postgres:16-alpine`) or binds to
   `--database-url` if the operator already provides an instance.
2. Creates a fresh disposable work copy of `examples/shopping-api` under temp.
3. Checks or records explicit acceptance of `coupon.single-redemption`.
4. Snapshots the copy and touches `src/coupons.ts` to trigger impact selection.
5. Runs the baseline: the concurrent race in `reproductions/coupon-race.test.ts`
   fails against the unconstrained database.
6. Runs `reproduce run` to classify the race as `reproduced`.
7. Applies the labeled patch `patches/0001-coupon-single-redemption.patch` in
   isolation, re-executes the stored selection against the migrated database,
   and verifies the fix.
8. Tears down the disposable container and copy, outputting `demo-report.json`.

Verified end-to-end: running `codecitadel demo coupon-race` exits 0 with
`coupon-race demo → DEMONSTRATED` and full audit trail of performed vs recorded acts.

### R1 slice 8E — evidence bundle export and replay (`evidence export`, `replay`)

Evidence bundles (`EVIDENCE_BUNDLE_SCHEMA_VERSION = 1`, ADR 0010) turn local
reports into portable, tamper-evident archives:
- `codecitadel evidence export <report> --out <bundle>`: reads a reproduction,
  run, or patch verification report, collects all referenced artifacts (test
  sources, manifests, diffs), computes SHA-256 digests over every file, captures
  execution requirements and permissions, and packages a self-contained bundle.
- `codecitadel replay <bundle> [path]`: enforces strict pre-execution validation:
  1. File size check against `EVIDENCE_BUNDLE_MAX_BYTES` (10 MiB limit).
  2. Zod contract validation.
  3. Recomputed SHA-256 digests and byte counts for EVERY bundled artifact; any
     tampering immediately aborts execution with exit code 2.
  4. Environment verification: any variable required by `permissions.env`
     (e.g. `CODECITADEL_DEMO_PG_URL`) must be present in the environment.
  5. Isolated re-execution in a disposable source copy.
  6. Replay verdict classification: `confirmed` (exit 0) when the replayed check
     observes the claimed outcome, `diverged` (exit 1) if the check behavior
     differs, and `inconclusive` (exit 2) on runner or infrastructure failure.

Verified by 4 contract unit tests, 7 core unit tests, and 5 CLI e2e tests covering
valid export, overwrite refusal, confirmed replay, diverged detection, and tamper
refusal before execution.

### Deliberately not implemented

- No generated reproduction, behavior-pack SDK, mutation testing, labeled patch
  proposal, or apply action. A reproduction is a check **you** write and declare;
  nothing proposes one from a finding, minimizes a payload, or repeats a flaky
  check. `patch verify` judges a patch you hand it against a stored run; nothing
  proposes one, tracks one, or adopts one into the checkout (there is no
  `patch apply`).
- Evidence persistence uses portable evidence bundles and replay (`codecitadel evidence export` / `codecitadel replay`); database-backed run history and hosted upload are part of R2.
- The comparison works on self-reported stored reports. Nothing verifies a
  report was actually produced by the runner it names, and the fingerprint does
  not capture test bodies: a same-name edit inside a test file is detectable
  only when the file's change classification differs between the two runs.
- No container isolation. The disposable copy has no CPU, memory, network, or
  syscall limits, and `node_modules` is shared with the checkout by link.
- No Jest adapter. Test discovery is limited to the files the TypeScript module
  graph reached; a test runner configuration that changes collection is the
  runner's business, and a selected file the reporter omits is reported as
  `errored`.
- No full TypeScript program: the module graph is built per file with module
  resolution only. Type-checking, `tsconfig` path aliases, and type-level data
  flow are out of scope, so type-only edges are reported but not resolved.
- No local API, database, dashboard, GitHub Action, MCP server, or AI provider.
- No registry publication, no release automation, no signed artifacts.
- No artifacts for Linux or macOS; those packages are manifests without binaries.

## R0 gate status

R0 requires that someone **outside** the monorepo can install a packed release
and scan clean and faulty repositories without an account or a Rust compiler.

| Gate item | Status |
| --- | --- |
| pnpm/Turborepo + Cargo workspaces | done |
| Contracts | done |
| Rust scanner | done |
| `scanner-client` with explicit resolution, protocol validation, limits | done |
| Minimal TS engine + CLI | done |
| Reports: JSON, Markdown, SARIF 2.1.0 | done |
| Prebuilt scanner artifacts for supported targets | **win32-x64 only** |
| Snapshot + change diff (R1 slice 1) | done, tested from a packed install |
| TypeScript module graph + impact selection (R1 slice 2) | done, tested from a packed install |
| Selected-test execution (R1 slice 3) | done, tested locally; **not** exercised from a packed install |
| Before/after execution comparison (R1 slice 4) | done, tested locally; **not** exercised from a packed install |
| Accepted requirements + evaluation (R1 slice 5) | done, tested locally; **not** exercised from a packed install |
| Patch verification against a stored run (R1 slice 6) | done, tested locally; **not** exercised from a packed install |
| Packed CLI installable outside the monorepo | **done for win32-x64** |
| `LICENSE` + third-party notices | done (direct dependencies only) |

R0 is passed **on Windows x64**, which is the only target with a real artifact:

```text
$ node scripts/verify-pack.mjs
Packing 7 package(s) into …\tarballs
  ok    every package produced a tarball
  ok    the CLI is installed outside the repository
  ok    the packed binary reports a version
  ok    doctor passes
  ok    the scanner comes from the installed platform package
  ok    the scanner binary lives inside the installed tree
  ok    a clean repository exits 0
  ok    a clean repository has no findings
  ok    a faulty repository exits 1 by default policy
  ok    a faulty repository reports 5 findings
  ok    the scan never prints the matched secret
  ok    the Markdown report renders from the packed install
  ok    the packed CLI emits SARIF 2.1.0 with every rule attached to a result
  ok    the SARIF report never prints the matched secret
  ok    the packed CLI writes a snapshot
  ok    an unchanged tree reports no introduced findings
  ok    an introduced finding is reported and can gate the diff
  ok    the packed CLI snapshots a project before analysis
  ok    impact selects the test that imports the changed module
  ok    impact reports a complete graph for the fixture
  ok    the packed CLI contains no absolute path into this checkout
All packed-install checks passed for win32-x64.
```

The script packs with `pnpm` (which rewrites `workspace:*` to real versions),
installs the tarballs into a temp directory with `npm`, then runs `doctor` and
two scans there with `CODECITADEL_SCANNER_BIN` unset. The scanner it uses is the
one inside the installed platform package, checksum-verified against
`binary.json`.

It also proves the install is local-only: the same thing against a registry is
not possible yet, because the packages are `private: true` and no namespace or
name-conflict check has been done.

## Known limitations and risks

- Only Windows x64 has been built and tested here. Linux/macOS are unverified,
  which is not the same as unsupported-in-principle.
- Discovery does not freeze a changing worktree (threat T13). Mutation testing
  or patch verification will need an immutable captured snapshot; `run` copies
  the tree but does not hash what it copied.
- Text rules cannot establish reachability or data flow; all findings are
  `suspected`.
- `pnpm install` requires the pnpm 11 `allowBuilds` entry for esbuild; removing
  it breaks Vitest.
- The report's `scope.options` is the scanner's effective configuration; future
  config files will need explicit precedence rules.
- The installed binary is SHA-256 verified on every launch, which costs ~30 ms
  per run here (10 runs: 2074 ms verified vs 1772 ms unverified, 2.9 MB binary).
- Nothing is published: packages are `private: true`, and the npm namespace,
  package names, and the project name itself are unchecked.
- `THIRD-PARTY-NOTICES.md` covers direct dependencies only; the transitive set is
  unaudited.
- `verify:pack` uses npm as the consumer installer and does not exercise `run`,
  because the consumer install has no Vitest. A packed `run` is unproven, and
  the packed `compare` and `requirements` commands are unproven for the same
  reason: they need a report that only a packed `run` could produce.
- A diff needs an explicit `--base` snapshot. There is no implicit "last scan"
  location, no pruning, and no locking beyond the write-once flag, so two
  processes racing on one path produce one winner and one error, not a merge.
- A diff re-scans the head tree every time; comparison cost is a full scan.
- Snapshots compare content and finding fingerprints only. They do not know which
  tests exist, which symbols changed, or what depends on what, so "resolved"
  means the pattern stopped matching in an analyzed file — nothing more.
- Impact is import reachability, not semantics: dynamic module loading, dependency
  injection, global registration, and test-runner globs are invisible. A test that
  is not selected is reported as not selected, never as safe.
- The module graph resolves one file at a time with `ts.resolveModuleName`. It does
  not read `tsconfig` path aliases or build a TypeScript program, so an aliased
  import shows up as unresolved and makes the impact result explicitly incomplete.
- Execution isolation is a disposable directory, not a sandbox: no container, no
  resource limits, shared `node_modules`, and symlinked files are skipped when
  copying. Config that references files above the analyzed root breaks in the
  copy, which surfaces as `errored` with the runner's message.
- `run` accepts a runner from the project (`--runner` or `node_modules`). That
  runner is not integrity-verified; its results are the runner's claims.
- Test failure messages are bounded to their first line; coverage, logs, and
  assertion detail are not retained. The raw reporter JSON must be saved with
  `--save-raw` or it is discarded with the temp directory.
- A `compare` verdict is only as good as its two self-reported inputs: nothing
  verifies that a report was produced by the runner it names, so an
  adversarially crafted pair can claim any outcome. The comparability gates
  check the environment and selection, not honesty.
- Equal change classifications between the compared reports do not prove that
  sources or test bodies are identical between the runs. `identitySuspect`
  covers the detectable half (classification differs); a same-name body edit
  with an equal classification is invisible. Test-body digests in the run
  report are the structural fix and were deliberately deferred (ADR 0006).
- A requirement's acceptance is bound to its text by a digest, not to a review.
  Editing a requirement to say something weaker and accepting it again produces
  a valid, weaker contract; the review of that diff is the control, not the
  hash. The digest also cannot tell a typo fix from a narrowed promise.
- Requirement checks name a test by file and full name. Renaming the test makes
  the check `not_run`, and a same-name body edit still satisfies it, so the
  check proves the named test passed — not that it asserts the statement. A
  check naming a test that does not exist is only visible once a run reports no
  result for it.
- `requirements check` does not compare the stored run's root or snapshot with
  the tree the document lives in, so a report produced from another checkout is
  accepted as evidence. Patch verification inherits the same gap: `patch verify`
  checks that the before report's root exists and nothing more, so report/tree
  identity is not proven. Root/snapshot binding is the structural fix for both.
- `patch verify` runs only the before report's stored selection. A test the
  patch adds, removes, or renames is never executed, so the patch's own tests
  are never judge and never accused.
- `patch verify` applies the patch to a copy whose `node_modules` is linked from
  the checkout: lockfile and dependency changes in the patch are applied to
  nothing that runs. The limitation is stated on every report.
- The weakening scanner is lexical: `expect(` counts per file miss net-zero
  rewrites inside an assertion, assertion splits, and renamed helpers. A
  same-body test edit that keeps its fingerprint is invisible to the verdict
  (the comparison marks it `identitySuspect` only when the file's change
  classification differs).
- Exact context matching refuses patches Git would apply with fuzz. Verifying
  a drifted patch would test a tree the author never saw, so the surplus
  strictness is deliberate: those patches exit 2 with the first mismatching
  line, and no test runs.

## Next task (in order)

1. **Upstream inventory.** Clone FixMySlop at the pinned commit, enumerate its
   rules, CLI commands, and report formats into `docs/parity.md`. Today every
   parity row is `blocked: not inspected`, which is the largest unknown left.
2. **Study documentation coverage.** Update `docs/study/` with flow chapters for
   the demo and replay commands, and run `pnpm docs:check`.
3. **Artifacts for the declared targets.** Run `pnpm scanner:package` on Linux
   x64 and macOS arm64 (or add cross-builds in CI), then `pnpm verify:pack` on
   each. Until then those rows stay "unverified" in `docs/support-matrix.md`.
4. **Phase 7 / R2: Hosted dashboard & API.** Thin local Fastify API/SSE, four UI
   workspaces, Monaco viewer, and report ingestion.
