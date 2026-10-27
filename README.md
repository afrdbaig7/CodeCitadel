# CodeCitadel

**What changed, what could break, and what evidence do we have?**

CodeCitadel is a code-quality and change-verification tool. It scans a checkout
without executing it, stores what it saw, compares a change against that stored
baseline, names the tests that can reach the change, and — only when asked — runs
those tests in a disposable copy and records the results.

`scan`, `diff`, and `impact` are static: nothing in the analyzed repository is
executed, no project configuration is loaded, and no dependency is installed.
`run` is the explicit execution path, and `patch verify` is the second one: it
applies a patch only inside a disposable copy and re-runs the stored experiment
there. The reports state where they ran and what they did not establish.

> **Status: pre-release, not published.** The packed release path works: seven
> tarballs install into an empty directory and scan with no Rust toolchain, and
> the installed scanner binary is checksum-verified before every run. **Only
> Windows x64 has a built artifact**, the packages are `private: true`, and no
> registry name/namespace check has been done, so nothing is on npm. See
> [`docs/progress.md`](docs/progress.md) and
> [`docs/support-matrix.md`](docs/support-matrix.md) for exactly what exists.

## What it does

- Discovers files with Git-compatible ignore rules (`.gitignore`,
  `.git/info/exclude`, global ignores), explicit glob exclusions, hidden-file
  policy, and bounded limits.
- Reads files with a per-file and total byte budget, computes SHA-256 content
  digests, skips binary and non-UTF-8 files with an explicit reason.
- Runs a small set of original text rules (six in this milestone) through a Rust
  scanner and normalizes the results into a versioned report.
- Prints JSON, Markdown, or SARIF 2.1.0, with stable finding fingerprints and
  redacted secret snippets. SARIF results keep the five-level severity and the
  evidence status in properties, because SARIF's three levels cannot express them.
- Stores an immutable per-scan **snapshot** (path, SHA-256 digest, skip reason
  per file) and compares a snapshot against the current tree with `diff`, which
  separates introduced, resolved, and *unverifiable* findings by file digest.
- Builds a TypeScript **module graph** from the scanner's file list and uses it in
  `impact` to name the tests that can reach a change, with the import chain that
  explains each selection.
- Runs those selected tests with `run`: a supervised, shell-free Vitest
  invocation inside a disposable copy of the tree, normalized into one result per
  test. Failures, timeouts, crashes, and missing results are separate outcomes,
  and the raw reporter JSON can be kept next to the normalized report.
- Compares two stored run reports with `compare`, pairing tests by fingerprint:
  which test newly fails, which got fixed, which stopped producing evidence —
  and refuses to certify a pair whose environments or selections differ.
- Reads accepted requirements from `codecitadel.requirements.json` and checks
  them against a stored run report. Each requirement names the tests that would
  count as evidence; only an explicit `requirements accept` makes it verifiable,
  and editing the text afterwards turns the acceptance stale.
- Verifies a proposed patch with `patch verify`: parses a unified diff strictly,
  applies it only inside a disposable copy, re-runs exactly the tests the stored
  before-report selected, pairs the outcomes by fingerprint, and inspects the
  diff itself — a patch that skips tests, removes assertions, suppresses
  diagnostics, or edits the requirement document cannot earn a `verified`
  verdict.
- Reproduces a declared failure with `reproduce run`: one check you name in
  `codecitadel.reproductions.json` is executed in a disposable copy and
  classified from that test's own result — an assertion failure is
  `reproduced`, a pass is `not_reproduced`, and a broken setup, timeout, or a
  name the runner never reported stays `inconclusive`. A reproduction linked to
  a requirement is refused before anything runs when the acceptance is missing
  or stale.
- Exports it with `reproduce export`: the check's exact source (verified against
  the digest in the report) is written at its original relative path with a
  provenance manifest, so the regression test runs with the project's own Vitest
  and imports nothing from CodeCitadel.
- Concurrency race demonstration with `demo coupon-race`: spins up PostgreSQL in a disposable container, verifies the baseline race in a Fastify shopping API, classifies the defect, and verifies the unique-constraint patch in isolation.
- Portable evidence bundles with `evidence export` and `replay`: generates tamper-evident archives verified by pre-execution SHA-256 checks before isolated re-execution.
- Reports its own limits. A truncated scan says so, a file that could not be
  re-read is reported as unverified rather than "removed", and the report always
  carries a limitations section.

## What it deliberately does not do

- It cannot prove reachability, data flow, or that a text match is a defect.
  Every finding is `suspected` evidence.
- `scan`, `diff`, and `impact` execute nothing. `run` executes test files only,
  only for the changes since a snapshot, and only when invoked; it does not apply
  patches, run package scripts, or install dependencies.
- It does not type-check TypeScript. `impact` selects tests by import
  reachability;`run` reports what the runner observed, not that a change is correct. `patch
verify` writes nothing outside a disposable copy, so the checkout and its
snapshots stay byte-identical. It does not resolve dependency types, or talk to
an AI provider.
- It does not judge requirements. `requirements accept` records an explicit
  approval and a digest over the accepted text; whether the statement is the
  right promise is a review question. Editing it and accepting again produces a
  valid, weaker contract.
- The execution isolation is a disposable directory, not a sandbox: no container,
  no CPU/memory/network limits, and `node_modules` is linked from the checkout.
  `run`, `patch verify`, and `reproduce run` execute repository code, so use them
  only on a repository you trust.
- It does not invent a reproduction. `reproduce run` executes a check you wrote
  and declared; it does not generate one from a finding, shrink it, or repeat it
  to measure flakiness. One run is one observation.
- It has no hosted service, dashboard, database, or authentication.
- It does not claim FixMySlop parity. Upstream FixMySlop parity audit complete: all 58 upstream rules, options, and server architectures cataloged in [`docs/parity.md`](docs/parity.md).

## Prerequisites

| Tool | Version used here | Notes |
| --- | --- | --- |
| Node.js | 24.18.0 | `engines.node >= 24` |
| pnpm | 11.20.0 | pinned via `packageManager` |
| Rust | 1.92.0 | only to build the scanner and its platform package |
| Git | 2.47.1 | not required yet; `doctor` warns if missing |

## Quick start

From a checkout (Rust required):

```bash
pnpm install
cargo build --release --package scanner-cli   # or: pnpm scanner:build
pnpm build

# a clean directory: exit 0
node apps/cli/dist/index.js scan fixtures/clean

# a deliberately faulty fixture: exit 1 (default policy: fail on high)
node apps/cli/dist/index.js scan fixtures/security --format markdown --fail-on none

# SARIF for a code-scanning upload (exit code still follows --fail-on)
node apps/cli/dist/index.js scan fixtures/security --format sarif --fail-on none > results.sarif

# record a baseline, then compare the tree against it later
mkdir -p .codecitadel   # ignored by git
node apps/cli/dist/index.js scan fixtures/security --fail-on none --save-snapshot .codecitadel/before.json
node apps/cli/dist/index.js diff fixtures/security --base .codecitadel/before.json

# which tests can see a change? (import-graph reachability, nothing executed)
node apps/cli/dist/index.js scan fixtures/impact --fail-on none --save-snapshot .codecitadel/impact.json
node apps/cli/dist/index.js impact fixtures/impact --base .codecitadel/impact.json

# run those tests in a disposable copy of the tree (this one does execute)
node apps/cli/dist/index.js scan . --fail-on none --save-snapshot .codecitadel/root.json
# edit any module a test imports, then run only the tests that can see it:
node apps/cli/dist/index.js run . --base .codecitadel/root.json --out .codecitadel/run-before.json --format json
# change the code (say, a fix), run again, and compare the stored reports:
node apps/cli/dist/index.js run . --base .codecitadel/root.json --out .codecitadel/run-after.json --format json
node apps/cli/dist/index.js compare --before .codecitadel/run-before.json --after .codecitadel/run-after.json
```

As an installed release (no Rust; proven by `pnpm verify:pack`):

```bash
pnpm scanner:package            # builds and fills npm/scanner-<your-platform>
pnpm build

TARBALLS=$(mktemp -d)           # absolute, so it survives the `cd` below
for pkg in contracts scanner-client core executor symbol-graph cli scanner-<your-platform>; do
  pnpm --filter "@codecitadel/$pkg" pack --pack-destination "$TARBALLS"
done

mkdir -p /tmp/try-codecitadel && cd /tmp/try-codecitadel
npm install --omit=optional "$TARBALLS"/*.tgz
node node_modules/@codecitadel/cli/dist/index.js doctor
node node_modules/@codecitadel/cli/dist/index.js scan .
```

Nothing is published, so this installs local tarballs rather than a registry
package. `pnpm verify:pack` does the same thing end to end and asserts the
results.

### Commands

```text
codecitadel scan [path]     scan a directory (default: .)
  -f, --format <format>    json (default), markdown, or sarif
  -o, --out <file>         write the report to a file
      --fail-on <severity> critical|high|medium|low|info|none (default: high)
      --rules <ids...>     run only these rule IDs
      --exclude <globs...> exclusion globs applied over ignore rules
      --max-files <count>  stop after N discovered files
      --scanner <path>     use a specific scanner binary
      --save-snapshot <file>  write an immutable snapshot of this scan
      --verbose            skip/warning diagnostics on stderr

codecitadel diff [path]     compare a stored snapshot with the current tree
  -b, --base <file>        snapshot to compare against (required)
  -f, --format <format>    text (default), json, or markdown
      --fail-on <severity> exit 1 on an *introduced* finding at/above this
                           severity (default: none)
      --save-snapshot <file>  also store the head snapshot
      --scanner <path>     use a specific scanner binary

codecitadel impact [path]   tests that can see the changes since a snapshot
  -b, --base <file>        snapshot to compare against (required)
  -f, --format <format>    text (default) or json
      --scanner <path>     use a specific scanner binary

codecitadel run [path]      execute the selected tests (runs repository code)
  -b, --base <file>        snapshot to compare against (required)
  -f, --format <format>    text (default) or json
  -o, --out <file>         write the report to a file
      --isolation <mode>   copy (default) or none (run in the checkout)
      --timeout-ms <ms>    kill the runner after this deadline (default: 120000)
      --runner <path>      path to node_modules/vitest/vitest.mjs
      --save-raw <file>    keep the runner's raw JSON report (refuses to overwrite)
      --scanner <path>     use a specific scanner binary

codecitadel compare         compare two stored run reports by fingerprint (reads two files, executes nothing)
  --before <file>          earlier run report (required)
  --after <file>           later run report (required)
  -f, --format <format>    text (default) or json

codecitadel requirements list [path]    requirements, states, and acceptance status
  -f, --format <format>    text (default) or json

codecitadel requirements accept <id> [path]  accept the requirement as written now
  --by <name>              who is recording the acceptance

codecitadel requirements check [path]   evaluate registered checks against a stored run
  --report <file>          run report to evaluate against (required)
  -f, --format <format>    text (default) or json

codecitadel patch verify <patch>  verify a unified diff against a stored run
  --before <file>           earlier run report (required); its test selection is
                            re-executed unchanged in a disposable copy
  --requirements <path>     requirement document or directory holding it
                            (default: codecitadel.requirements.json at the analyzed root)
  --runner <path>           path to the runner entry (e.g. node_modules/vitest/vitest.mjs)
  --timeout-ms <ms>         deadline for the post-patch run
  -o, --out <file>          write the verification report to a file
  -f, --format <format>     text (default) or json

codecitadel reproduce run <manifest> [path]  execute one declared reproduction
  --id <id>                 reproduction id declared in the manifest (required)
  --requirements <path>     requirement document or directory holding it
  --runner <path>           path to the runner entry (e.g. node_modules/vitest/vitest.mjs)
  --timeout-ms <ms>         deadline for the run
  -o, --out <file>          write the reproduction report to a file
  -f, --format <format>     text (default) or json

codecitadel reproduce export <report>  write the test source and its provenance
  --out <dir>               destination directory (required)
  --force                   overwrite an existing file at the destination
  --in-root                 allow writing inside the analyzed checkout
  -f, --format <format>     text (default) or json

codecitadel doctor          environment, binary, and protocol checks
  -f, --format <format>    text (default) or json
  --scanner <path>         check a specific scanner binary
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The requested policy was satisfied |
| `1` | A finding breached the configured policy (`--fail-on`), including an introduced finding in `diff`; a selected test failed in `run`; a compared pair's after side contains a failing test in `compare`; an accepted requirement is unmet in `requirements check`; a patch carries weakening signals, regresses accepted requirements, or fails its tests in `patch verify`; or a declared reproduction did not fail in `reproduce run` (`not_reproduced`) |
| `2` | Invocation, infrastructure, or protocol error — including an incomplete scan, an inconclusive `run` (timed out, cancelled, unsupported, or no usable result), a `compare` pair that is not comparable or lost evidence, a requirement that is inconclusive, stale, or unreadable, a patch that did not apply or is inconclusive in `patch verify`, or a reproduction that is inconclusive or whose requirement is not accepted |

A `2` is never a clean result. Neither is a report whose `scope.truncated` is
`true`, nor a `run` whose record says `skipped` because no test could see the
change.

## Repository layout

```text
crates/scanner-core     Rust library: discovery, digests, text rules, protocol
crates/scanner-cli      Thin NDJSON executable (codecitadel-scanner)
packages/contracts      Zod schemas: findings, scanner protocol, report
packages/scanner-client Binary resolution, subprocess, record validation
packages/core           Engine facade, report assembly, snapshots + diffs
packages/symbol-graph   TypeScript module graph + impact/test selection
packages/executor       Disposable source copy, supervised Vitest runner, normalization
apps/cli                codecitadel command line interface
npm/scanner-<plat>      Prebuilt scanner binary per platform (artifact is generated)
scripts/                Packaging, packed-install verification, docs checker, notices
fixtures/               Clean controls, faulty fixtures, captured protocol record
docs/                   Progress, architecture, ADRs, threat model, parity plan
```

Detailed design: [`docs/architecture.md`](docs/architecture.md).
Trust boundaries: [`docs/threat-model.md`](docs/threat-model.md).

## Development

```bash
pnpm install
cargo build --release --package scanner-cli
pnpm build
pnpm typecheck
pnpm test                      # TypeScript unit + CLI end-to-end (including one real Vitest run)
cargo test --workspace         # Rust unit + protocol fixture
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
pnpm scanner:package           # build + checksum the host platform package
pnpm verify:pack               # pack, install outside the repo, scan there
pnpm notices                   # regenerate THIRD-PARTY-NOTICES.md
```

The end-to-end tests spawn the real scanner against `fixtures/`; they fail with
an actionable message if the binary is missing rather than skipping.

## License

Apache-2.0 (see [`LICENSE`](LICENSE)). Direct dependencies and their declared
licenses are listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md),
generated by `pnpm notices`; a transitive audit is still outstanding.

Publishing is separate from licensing and is still blocked: packages are
`private: true`, and the npm namespace, package names, and the project name
itself have not been checked for conflicts.
