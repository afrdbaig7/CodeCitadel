# Progress

Last updated: 2026-10-27 — R2 slice 8F (report upload to the control plane).

## Milestone: Phase 0, R0 gate, R1 slices 1–8, R2 slice 8F (report upload)

R1 slices 1–8 are done (snapshots + diff, impact, run, compare, requirements,
patch verification, reproduction + export, coupon demo, evidence export & replay)
and R2 slice 8F completes the first client side of the control plane: the CLI can
upload a stored report, the server validates, authorizes, stores, and returns it.
Everything that runs repository code does so inside a disposable copy (or, for
uploads, inside the operator's own checkout — uploads do not copy anything).

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
| Supervised run: shell-free argv, deadline with SIGTERM→SIGKILL, cancellation, 64 KiB output budget, allow-listed environment with explicit named forwarding (`--env`) | `packages/executor/src/process.ts`, `packages/executor/test/process.test.ts`; CLI e2e timeout and forwarding cases |
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
| CLI `scan` (JSON/Markdown/SARIF, policy exit codes), `diff`, `impact`, `run`, `compare`, `requirements`, `patch verify`, `reproduce run|export`, `demo coupon-race`, `evidence export`, `replay`, `upload`, `doctor` | `apps/cli/test` → 89 tests (12 files), most spawning the real binary |
| End-to-end demonstration (`codecitadel demo coupon-race`): starts/connects PostgreSQL, work copy, accepts requirement, runs baseline, reproduces concurrency race, verifies labeled patch, teardown | `apps/cli/test/demo.e2e.test.ts` (4 tests) + real Docker container execution (`DEMONSTRATED`) |
| Evidence bundle export (`codecitadel evidence export`): packages report + artifacts into tamper-evident container with per-file SHA-256 digests and permissions | `packages/contracts/test/evidence.test.ts` (4 tests), `apps/cli/test/evidence.e2e.test.ts` (5 tests) |
| Evidence bundle replay (`codecitadel replay`): strict pre-execution schema/digest/size/env checks, isolated re-execution in disposable copy, confirmed/diverged verdict | `packages/core/test/evidence.test.ts` (7 tests), `apps/cli/test/evidence.e2e.test.ts` (5 tests) |
| Packed CLI installable outside the monorepo (win32-x64) | `scripts/verify-pack.mjs` → 21 checks, all passing |
| Evidence upload to the control plane: `codecitadel upload`, CLI interop test against the real Fastify server | `apps/cli/test/upload.e2e.test.ts` (8 tests) + real end-to-end round trip (stored report, read back byte-identical, artifact digest header verified) |
| Local control plane: Fastify API/SSE-less, bearer-token auth, tenant-scoped runs, artifact artifact, 8 MiB upload limit | `apps/api` (Fastify 5.12.7, SQLite), `apps/api/test/api.test.ts` (35+ tests) |
| Study documentation: index with reading paths and 9 reviewed flow chapters (scan, requirements+patch, evidence+replay, demo, reproduction+export, impact, execution comparison, accepted requirements, snapshots+diffs, packaging) | `docs/study/` + `docs/study/coverage-report.md`; `pnpm docs:check` clean |

### Commands run (actual results)

```text
cargo test --workspace                     → 32 passed, 0 failed
cargo clippy --workspace --all-targets -D warnings → clean
cargo fmt --all --check                    → clean
pnpm typecheck                             → 15 tasks, clean
pnpm build                                 → 8 packages built
pnpm test                                  → 89 passed in apps/cli (12 suites); 294 passed across all packages, 0 failed
node scripts/package-scanner.mjs           → win32-x64 artifact, sha256 recorded
node scripts/verify-pack.mjs               → 7 tarballs, 21 checks, all passing
node scripts/docs-check.mjs                → docs:check — clean
```

### The control plane, in one paragraph

`apps/api/src/server.ts` builds a Fastify app from `apps/api/src/index.ts`. One
route (`POST /api/v1/reports`) authenticates a bearer token against the SQLite
store, validates the envelope with the same contract the CLI validates, stores
the report JSON and its small artifacts atomically, and returns the stored run.
Reads are tenant-scoped: a listing never reads a report body, a detail read
joins the body in, and an artifact read checks the tenant before the path. The
`health` route prints what this deployment does and does not do, every time.

## R1 slice 8F — upload to the control plane

R2's first client slice. The CLI reads the report the operator already produced,
validates its shape against the API contract before the network is touched, adds
the facts the report cannot carry (`capturedAt` from its own timestamp, the
repository name from its root), and sends a single envelope. On the server side,
a stored run keeps its report byte-for-byte; the artifact count is recorded, and
the digest header is returned on every artifact read so a consumer can check the
byte stream without trusting the store.

Verified by `apps/cli/test/upload.e2e.test.ts` (8 tests) against the real
`apps/api/dist/main.js` and by a hand-run round trip (stored → detail → artifact
all read back over HTTP, report identical, artifact byte-identical).

## R2 slice 8G — Postgres-backed control plane (pending)

The control plane is currently SQLite-only. PostgreSQL changes the schema story:
Drizzle migrations, tenant-aware pooling, and the `storage.driver: "postgres"`
health field. The CLI does not change.

## Next task (in order)

1. **R2 slice 8G: PostgreSQL/Drizzle storage driver** — same `ReportStore`
   interface, new `storage.driver: "postgres"` health field, migrations recorded
   in `packages/storage/src/db-postgres.ts`.
2. **R2 slice 8H: private object storage** — S3-compatible upload of full
   artifacts, with the API contract telling clients it is not the default yet.
3. **R2 slice 8I: established OIDC identity** — bearer tokens are now plaintext
   forever; an identity provider swap is the only way the platform can ever
   rotate a tenant's keys.
4. **R2 slice 8J: organizations, permissions, and the first UI views** — four
   workspaces for the dashboard, and read-only views for the stored runs.
