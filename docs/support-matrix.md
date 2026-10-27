# Support matrix

Updated 2026-10-23. A capability is listed as implemented only when there is
automated evidence in this repository.

## Capabilities

| Capability | State | Evidence |
| --- | --- | --- |
| Passive directory scan (no code execution) | implemented | `crates/scanner-core/src/scan.rs`, `apps/cli/test/scan.e2e.test.ts` |
| Git ignore rules (`.gitignore`, info/exclude, global; works outside a git repo) | implemented | `discovery.rs` tests |
| Explicit glob exclusions | implemented | `discovery.rs` test |
| Hidden-file policy | implemented | `discovery.rs` test (default skip, opt-in include) |
| Per-file / total byte / file-count / findings-per-file limits | implemented | `hashing.rs`, `scan.rs` tests |
| SHA-256 content digests (schema v1) | implemented | `hashing.rs` known-answer test |
| Binary and non-UTF-8 skip reasons | implemented | `hashing.rs`, `scan.rs` tests |
| Six `native-text` rules | implemented | `rules.rs` tests + CLI e2e |
| Secret redaction | implemented | `rules.rs`, `scan.rs`, CLI e2e, Markdown e2e |
| Stable finding fingerprint | implemented | `finding.rs` tests, CLI determinism test |
| JSON report | implemented | report schema + e2e |
| Markdown report | implemented | `apps/cli/src/render.ts` + e2e |
| SARIF 2.1.0 report | implemented | `apps/cli/src/sarif.ts`, `apps/cli/test/sarif.test.ts` (7 tests), CLI e2e, packed install |
| HTML / CSV / PDF reports | planned | — |
| `codecitadel scan`, `codecitadel doctor` | implemented | CLI e2e |
| `codecitadel diff`, `codecitadel impact`, `codecitadel run` | implemented | CLI e2e |
| Immutable per-scan snapshot (paths, SHA-256 digests, skip reasons, coverage options) | implemented | `packages/contracts/src/snapshot.ts`, `packages/core/test/snapshot.test.ts`, CLI e2e (write-once) |
| Change diff between two observations (files + findings, with unverified states) | implemented | `packages/core/src/snapshot.ts`, `packages/core/test/snapshot.test.ts`, CLI e2e |
| `codecitadel diff` with text, JSON, and Markdown output; `--fail-on` gates introduced findings only | implemented | `apps/cli/src/commands/diff.ts`, `apps/cli/test/diff.e2e.test.ts` |
| TypeScript module graph from the scanned file list (imports, re-exports, `require`, dynamic import) | implemented | `packages/symbol-graph/src/graph.ts`, 9 unit tests |
| Impact analysis: backwards reachability from changed files, explained chains, completeness reporting | implemented | `packages/symbol-graph/src/impact.ts`, 10 unit tests |
| `codecitadel impact` with text and JSON output; never executes a test | implemented | `apps/cli/src/commands/impact.ts`, `apps/cli/test/impact.e2e.test.ts` |
| `codecitadel run`: executes the selected Vitest files, reports per-test outcomes | implemented (Vitest only) | `packages/executor`, `apps/cli/test/run.e2e.test.ts` (7 tests spawning real Vitest, both isolation modes) |
| Disposable source copy as the default execution root | implemented | `packages/executor/src/copy.ts`, `run.e2e.test.ts` writes a marker outside the checkout |
| Supervised process: deadline, SIGTERM→SIGKILL, cancellation, bounded output, allow-listed environment | implemented | `packages/executor/src/process.ts`, timeout e2e test |
| Machine-readable reporter validation and normalization | implemented | `packages/executor/src/vitest-report.ts`, 13 unit tests |
| `codecitadel compare`: pairs two stored run reports by test fingerprint, labels outcome changes, refuses non-comparable pairs | implemented | `packages/core/src/compare-execution.ts` (13 unit tests), `apps/cli/test/compare.e2e.test.ts` (6 tests through the real binary) |
| `codecitadel requirements list`, `accept`, `check` | implemented | `apps/cli/src/commands/requirements.ts`, `apps/cli/test/requirements.e2e.test.ts` |
| `--fail-on` policy exit codes | implemented | CLI e2e |
| Rule allowlist with hard error on unknown IDs | implemented | core engine + CLI e2e |
| TypeScript AST rules / tsconfig resolution | planned | — |
| Symbol-level narrowing (which export changed, which importer uses it) | planned | — |
| `tsconfig` path aliases and full TypeScript program checking | planned | — |
| Jest adapter, test discovery beyond Vitest | planned | — |
| Container-grade execution isolation, network/CPU/memory limits | planned (R4) | — |
| Declarative requirement documents (strict schema v1, stable ids, registered checks) | implemented | `packages/contracts/src/requirements.ts`, `packages/core/test/requirements.test.ts` (15 tests) |
| Explicit requirement acceptance with a digest over the accepted text; stale detection on read | implemented | `packages/core/src/requirements.ts`, `requirements` CLI e2e |
| Requirement evaluation against a stored run report (`met` / `unmet` / `inconclusive` / `not_accepted`) | implemented | `evaluateRequirements`, `apps/cli/test/requirements.e2e.test.ts` (7 tests) |
| Behavior-pack SDK (authorization, token lifecycle, idempotency, webhooks, transactions, pagination) | planned | — |
| Declared reproduction of one check, classified from that test's own result (disposable copy, requirement gate, `reproduced` / `not_reproduced` / `inconclusive` / `not_accepted`) | implemented | `packages/contracts/src/reproduction.ts`, `packages/core/src/reproduction.ts`, `apps/cli/test/reproduce.e2e.test.ts` (6 e2e tests) + 16 core + 9 contract unit tests |
| Portable regression export (test source at its original relative path, provenance manifest, digest verification, no silent overwrite) | implemented | `apps/cli/src/commands/reproduce.ts`, same e2e suite (5 tests, including running the exported file alone) |
| Generated reproductions, payload minimization, flake repetition, evidence bundles and replay | planned | — |
| Verification of a patch against a stored run (disposable copy, weakening detection, requirement regression check) | implemented | `packages/executor/src/diff-parse.ts` + `packages/executor/src/patch.ts`, `packages/core/src/patch-verification.ts`, `apps/cli/test/patch.e2e.test.ts` (5 e2e tests) + 16 core + 13 executor unit tests |
| Mutation testing (StrykerJS) | planned | — |
| Patch proposals and apply action | planned | — |
| Local API / dashboard | planned | — |
| GitHub Action, MCP server, AI providers | planned | — |
| Prebuilt scanner binary in a per-platform package | implemented (win32-x64 artifact only) | `scripts/package-scanner.mjs`, `npm/scanner-win32-x64` |
| Platform-package resolution with SHA-256 verification | implemented | `resolve-binary.test.ts` (valid, tampered, missing manifest, path escape) |
| Packed install outside the monorepo, no Rust toolchain | implemented (win32-x64) | `scripts/verify-pack.mjs` — 21 checks, all passing |
| Publishing to a registry | blocked | packages are `private: true`; namespace and name conflicts unchecked |

## Platforms

| Platform | Platform package defined | Scanner built | Tests run | Notes |
| --- | --- | --- | --- | --- |
| Windows x64 | yes (`@codecitadel/scanner-win32-x64`) | yes (Rust 1.92.0, MSVC) | yes | All suites run here; packed install proven |
| Linux x64 (glibc) | yes (`@codecitadel/scanner-linux-x64`) | no | no | Package manifest only; unverified |
| macOS arm64 | yes (`@codecitadel/scanner-darwin-arm64`) | no | no | Package manifest only; unverified |
| Linux x64 (musl) | no | no | no | Unverified |
| Linux arm64 | no | no | no | Unverified |
| macOS x64 | no | no | no | Unverified |

"Unverified" means nobody has built or run it here. It does not mean the code is
known to be incompatible, and it must not be described as supported.

## Runtimes

| Runtime | Declared | Tested |
| --- | --- | --- |
| Node.js 24.x | `engines.node >= 24` | 24.18.0 |
| Node.js 22.x | not declared | no |
| pnpm 11.20.0 | `packageManager` | yes |
| Rust 1.85+ (`rust-version`) | minimum | 1.92.0 |

## Rule inventory (native-text, version 1.0.0)

| Rule | Category | Severity | Confidence | Notes |
| --- | --- | --- | --- | --- |
| `secrets/aws-access-key-id` | secrets | high | high | Redacted; extension-gated |
| `secrets/private-key-material` | secrets | critical | high | Redacted |
| `security/tls-verification-disabled` | security | high | medium | JS/TS only |
| `security/dangerous-html-sink` | security | medium | low | Sink only; not taint analysis |
| `security/shell-enabled-subprocess` | security | medium | low | JS/TS only |
| `quality/committed-todo-marker` | quality | info | high | Bookkeeping, not a defect |

These are pattern checks. Confidence is per rule and does not raise the evidence
status above `suspected`.

## Comparison classes

A diff distinguishes outcomes that are easy to conflate:

| Situation | Reported as |
| --- | --- |
| content digest equal in both snapshots | `unchanged` |
| digest differs | `modified` |
| verified only in the head | `added` |
| verified only in the base, head not truncated | `removed` |
| verified in the base, unreadable in the head | `unverified` — never `removed` or `unchanged` |
| finding gone, file analyzed in the head | `resolved` |
| finding gone, file skipped as binary/non-UTF-8 or unreadable | `unverified` — never `resolved` |
| finding gone, file outside a truncated head scan | `unverified` — never `resolved` |
| enabled rules or coverage options differ | reported; the diff says configuration changed |

"Unverified" is a result. It means the tool does not know, and the output says so.

## Impact selection

`impact` combines the diff with a module graph. It distinguishes four states:

| Situation | Reported as |
| --- | --- |
| a test file that changed itself | selected, depth 0 |
| a test that imports the change directly or transitively | selected, with the shortest import chain |
| a test in the graph that cannot reach any change | `notSelected` count — explicitly not "safe" |
| a changed file that is not in the graph | `complete: false` plus a reason |
| an unresolvable local import, an unparsed source file, or an import outside the scanned scope | `complete: false` plus a reason |
| a bare/package import | counted, not followed, listed as a limitation |

`complete: false` means the selection is a lower bound. The command never exits
non-zero because tests were selected: naming candidates is advice, not a verdict.

## Execution outcomes

`run` reports what the runner observed, and nothing else:

| Observed | Reported | Exit code |
| --- | --- | --- |
| every selected test passed | `passed` | 0 |
| at least one test failed | `failed` | 1 |
| deadline reached | `timed_out`, no results | 2 |
| caller cancelled | `cancelled`, no results | 2 |
| collection error, crash, unreadable report, or a selected file with no result | `errored` | 2 |
| Vitest is not installed / cannot be resolved | `unsupported` | 2 |
| no test file could see the change | `skipped`, `command: []` | 0 |

A skipped or errored run is never presented as a pass. The report always names
the isolation mode (`source-copy` or `none`), the `node_modules` paths that were
linked instead of copied, and at least three limitations.

## Before/after execution comparison

`compare` reads two stored run reports and pairs their per-test results by
fingerprint. The label is always from the after side's point of view:

| Pair | Label | Exit-code weight |
| --- | --- | --- |
| failed → failed | `still_failing` | 1 |
| passed → failed | `newly_failing` | 1 |
| failed → passed | `fixed` | 0 |
| passed → passed | `still_passing` | 0 |
| absent → passed | `newly_passing` | 0 |
| same inconclusive → unchanged | `still_inconclusive` | 2 |
| anything → inconclusive | `newly_inconclusive` | 2 |
| skipped → skipped | `still_skipped` | 0 |
| anything → skipped | `newly_skipped` | 2 |
| present → absent | `gone` | 0 |

`compare` exits 2 outright when the pair is not comparable: differing roots,
platforms, Node versions, runner versions, isolation modes, selected test
files, or change classifications. The pairing is still printed with the
reasons. Entries whose test file's change classification differs between the
two runs are flagged `identitySuspect: true`, because the fingerprint covers
the file and test name, not the test body: an equal id is not proof the test
text is unchanged.
