# Milestone plan

Delivery order from the project specification, adapted to what is actually built.
Current position: **R0 gate met on Windows x64**; other targets and publishing
remain open. **R1 slices 1–7 are done**: immutable snapshots, a change diff over
files and findings, a TypeScript module graph, impact-based test selection with
an explanation per test, supervised Vitest execution of the selected tests
in a disposable copy, a fingerprint-based before/after comparison of two
execution reports, declarative requirements with explicit, digest-bound
acceptance plus evaluation against a stored run, patch verification — a
strict unified-diff parser, an application inside a disposable copy, a
re-execution of the stored test selection, weakening detection, and a verdict
that a patch cannot rig — and reproduction with portable export: one declared
check executed in a disposable copy, classified from the named test's own
result, gated on a current acceptance, and exported as an ordinary regression
test with a provenance manifest. One behavior pack, evidence replay, the labeled
proposal, and the coupon demo have not started.

## R0 — Installable foundation

| Item | Status |
| --- | --- |
| pnpm + Turborepo workspace, Cargo workspace | done |
| Contracts (findings, protocol, report) | done |
| Rust scanner (discovery, digests, six text rules) | done |
| `scanner-client` (resolution, validation, limits) | done |
| Minimal engine facade + report assembly | done |
| CLI `scan` (JSON, Markdown, SARIF 2.1.0) and `doctor` | done |
| Clean and faulty fixtures, unit + e2e tests | done |
| Selected-test execution (`run`) with normalized per-test evidence | done (Vitest, disposable copy, no container) |
| Prebuilt scanner binaries for tested targets | win32-x64 done; linux-x64 and darwin-arm64 unbuilt |
| Packed release installable outside the monorepo | done for win32-x64 (`pnpm verify:pack`) |
| `LICENSE`, notices, release automation | license and notices done; release automation todo |
| Registry publication | **blocked** (private packages, names unchecked) |

**Gate:** a developer outside the monorepo installs the packed release and scans
clean and faulty repositories without an account or a Rust compiler. — met on
Windows x64 only; not yet on Linux or macOS.

## R1 — Local verification preview

Requires: immutable snapshots, diff parsing, TypeScript symbol graph with
explained test selection, isolated executor, Vitest adapter, accepted
requirements, one behavior pack, reproduction, regression export, a labeled
deterministic patch, and before/after checks.

Status: snapshots (`scan --save-snapshot`) and change diffs (`diff`) exist and are
tested from a packed install. A diff reports added/modified/removed/unverified
files and introduced/resolved/unverified findings, and refuses to call a finding
resolved when its file was not analyzed. `impact` maps the changed files through
a TypeScript import graph and names the tests that can reach them, with the
import chain per test and `complete: false` whenever the graph has a hole.
`run` executes exactly those tests through a supervised Vitest process in a
disposable copy of the tree, with per-test statuses (`passed`, `failed`,
`skipped`, `timed_out`, `errored`, `cancelled`, `unsupported`) and a record of
the exact argv, versions, exit code, and isolation mode. `compare` pairs two
stored run reports by test fingerprint and labels every outcome change, and
refuses to certify a pair whose environments, selections, or change
classifications differ. `requirements` reads a committed document of stable,
statement-bearing requirements whose checks name tests, accepts a requirement
only through an explicit command that records a digest over its text, marks an
acceptance stale when that text changes, and evaluates the checks against a
stored run as `met`, `unmet`, `inconclusive`, or `not_accepted`.
`patch verify` completes the comparison story: it parses a unified diff
strictly (no `git` binary, absolute/`..`/symlinked paths refused), applies it
only inside a disposable copy (exact context matching — stale patches refuse
before any test runs), re-loads the before report's selected test files in the
patched copy through the same Vitest adapter `run` uses, pairs the outcomes by
fingerprint, and decides the verdict in core: not applied, weakening signals
and requirement regressions block `verified` outright, inconclusive statuses
and incomparable pairs refuse to claim anything, and only a green suite with no
weakening earns `verified`. Exit codes: 0 verified, 1 not verified, 2 not
applied or inconclusive. `reproduce run` executes exactly one declared check in
a disposable copy, refuses before execution when the requirement it names is not
accepted as written, and classifies only the named test's own result
(`reproduced` / `not_reproduced` / `inconclusive` / `not_accepted`);
`reproduce export` writes that check at its original relative path plus a
provenance manifest, verifying the report's source digest and refusing a silent
overwrite or an in-checkout write without `--in-root`.
Slice 8A adds the demonstration target: `examples/shopping-api` is a standalone
Fastify + PostgreSQL project whose `redemptions` table has no uniqueness
constraint behind a check-then-insert, with passing sequential tests and a
concurrency check that fails on this checkout as intended (8 accepted responses,
8 stored redemptions, repeatably, via the labeled hold hook). Slice 8B links it
to the CLI: `coupon.single-redemption` is accepted in the fixture with three
checks, and `reproduce run` is gated on that acceptance and classifies the race
`reproduced` (editing the statement first makes it `not_accepted` with
`record: null`). Slice 8C adds the labeled deterministic patch — a migration that removes
duplicates explicitly and adds a unique index on
`redemptions (user_id, coupon_id)`, plus conflict handling in the service —
verified by `codecitadel patch verify` against the unchanged reproduction
(`--env` reaches the demo database; a comment-only patch is refused as
`not_verified`, so the green verdict is the constraint's, not the tool's). Still
missing: symbol-level narrowing, one accepted behavior pack, evidence replay, and
the `demo coupon-race` command.

**Gate:** the coupon race demo reproduces a real failure on a real database, the
exported test runs without CodeCitadel, and a labeled patch is verified against
the unchanged original reproduction. Evidence bundles then travel, tamper-evidently,
from one machine to another and replay with a declared environment.

**Consumers of evidence now exist:** the CLI can upload a stored report to the
local control plane (`codecitadel upload`), which validates and stores it and
serves it back per tenant with artifact digest headers. The CLI/MVP story is
complete; the hosted story is still R2.

## R2 — Hosted dashboard beta

The CLI/user CI executes checks; the server validates, authorizes, stores, and
displays evidence. The local control plane exists (SQLite), and the CLI side of
report upload is complete. The hosted story is left to the checklist below.

**This milestone's checklist:**

- [x] **8F — report upload on the CLI.** `codecitadel upload` sends a stored
      report to a local control plane and reads it back; 8 e2e tests pass.
- [x] **8F.1 — local dashboard workbench.** `codecitadel serve` serves the
      built dashboard on loopback, sets one ephemeral token as a same-site
      cookie, and the four workspaces read stored runs (or a labeled preview
      dataset). 6 serve e2e tests pass.
- [x] **8G — PostgreSQL/Drizzle storage.** `PostgresReportStore` implements
      the shared `EvidenceStore`; `storage.driver: "postgres"` and the applied
      migration version appear on health; ordered migrations live in
      `packages/storage/src/db-postgres.ts`. Real PostgreSQL storage/API suites
      pass (7 integration tests).
- [ ] **8H — private object storage.** full artifacts leave the store;
      `storage.driver: "s3"` behind an explicit flag.
- [ ] **8I — established OIDC identity.** bearer tokens rotate behind an
      identity provider; plaintext tokens are a local-plane detail, not a
      hosted platform property.
- [ ] **8J — hosted organizations, permissions, and identity.** the four local
      workspaces exist; the hosted deployment still needs multi-tenant identity,
      per-run permissions, and Postgres/object storage behind them.

**Gate for the checklist:** cross-tenant access denied in automated tests;
uploaded evidence is labelled with its execution origin and never presented as
managed execution. The control plane obeyed that gate in the SQLite edition.

## R3 — GitHub workflow and community release

Version-pinned Action using the same CLI, SARIF/Markdown output, retained
reproduction artifacts, documented fork permissions, contribution tutorials, and
a support matrix backed by real runs.

## R4 — Managed execution

Temporal, transactional outbox, trusted orchestration workers, disposable
sandboxes, quotas, and the hosted security gates. Kubernetes/gVisor belong here,
subject to tested compatibility and threat modelling.

## R5 — Scale measured workloads

Valkey caches, PgBouncer, autoscaling, and tuning when observations justify them.
Capacity claims require load tests with recorded hardware, workload, and results.

## Definition of done (every milestone)

Working code, meaningful validation, usable instructions, versioned contracts
where relevant, and honest limitations. No TODOs standing in for behaviour, no
mocked execution results, no dashboard that invents data.
