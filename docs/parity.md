# FixMySlop parity matrix

**Status:** Inspected against upstream pinned commit `e16bee18b9f27ae882e69e105e4f8b21e1e04b6f` (tag `v0.6.8`).

CodeCitadel was inspired by FixMySlop. This file records the exact upstream capabilities,
how CodeCitadel implements or adapts them, what remains planned or intentionally
different, and the license/provenance record.

## Upstream pinned inspection baseline

| Field | Value |
| --- | --- |
| Repository | `https://github.com/MrSpideyNihal/FixMySlop` |
| Commit | `e16bee18b9f27ae882e69e105e4f8b21e1e04b6f` |
| Tag / Release | `v0.6.8` |
| Commit subject | `Merge pull request #23 from MrSpideyNihal/release/0.6.8` |
| Commit date | 2026-10-21 |
| License | MIT License (Copyright 2024 FixMySlop Contributors) |
| Source inspected? | **Yes** (cloned locally at tag v0.6.8 and audited) |
| License compatibility | Permissive MIT License; compatible with CodeCitadel (Apache-2.0) |

---

## Architectural Comparison & Intentional Differences

| Dimension | FixMySlop upstream (`v0.6.8`) | CodeCitadel | Rationale / Difference |
| --- | --- | --- | --- |
| **Language & Runtime** | Python 3.10+ (Typer, Rich, PyMuPDF, AST) | Rust native scanner core (`crates/`) + TypeScript ESM (`packages/`, `apps/`) | Zero-toolchain client installation via prebuilt platform packages; sub-millisecond bounded scanning. |
| **Scanner Architecture** | In-process Python file tree walk & regex/AST checks | Native Rust scanner subprocess communicating via versioned NDJSON protocol (`PROTOCOL_MAJOR = 1`) | Memory bounds, process isolation, non-blocking asynchronous UI/CLI, crash resistance. |
| **Change Analysis** | `--changed` with Git diff parsing | Immutable content-addressed snapshots (`RepositorySnapshot`) + backwards reachability TS module graph | Exact differential findings, explained test impact chains without false certainty. |
| **Test Verification** | Static scan only; no code execution | Supervised execution in disposable copy (`codecitadel run`), before/after comparison (`compare`), accepted requirements (`requirements`) | Verification requires observing actual execution outcomes, not guessing from text. |
| **Reproduction & Evidence** | No reproduction runner or evidence bundle | Declared reproductions (`reproduce run`), portable test export (`reproduce export`), tamper-evident Evidence Bundles (`evidence export`, `replay`) | Reproductions provide reproducible counterexamples that run independently. |
| **Patch Verification** | LLM-based rewrite (`--fix` via agent prompt) | Isolated patch verification (`patch verify`): strict unified diff parsing, weakening detection, re-execution of stored selection | Fixes must be deterministically proven to repair the failure without weakening assertions or types. |
| **Persistence** | File-based `.fixmyslop-baseline.json` and report exports | Stored JSON reports, versioned contracts, evidence bundles, and SQLite/PostgreSQL storage | Structured, verifiable contracts with cryptographic integrity. |

---

## Command Parity Matrix

| Upstream Command | Upstream Behavior | CodeCitadel Implementation | Status | Differences & Notes |
| --- | --- | --- | --- | --- |
| `fixmyslop scan [PATHS]` | Passive scan with formats: text, compact, markdown, html, json, csv, sarif, prompt, pdf | `codecitadel scan [path]` (`--format json\|markdown\|sarif`, `--fail-on`) | **implemented** | Native Rust scanner; JSON, Markdown, and SARIF 2.1.0 output. HTML/PDF in Phase 7. |
| `fixmyslop scan --changed` | Scans changed files vs Git base branch | `codecitadel diff [path] --base <snapshot>` | **implemented** | CodeCitadel uses immutable snapshot diffing rather than relying on Git working tree state. |
| `fixmyslop scan --baseline` | Filters findings recorded in `.fixmyslop-baseline.json` | Snapshot comparison (`introduced` vs `carried over` findings) | **implemented** | Carried over findings are explicitly classified; baseline contract tracked for Phase 2. |
| `fixmyslop rules [RULE_ID]` | Explains rules from the registry | Native rule registry in Rust + `codecitadel scan --rules <ids...>` | **partial** | `codecitadel scan` allows rule filtering; CLI rule explanation command planned. |
| `fixmyslop fix [PATHS]` | Applies safe deterministic regex fixes, then LLM | `codecitadel patch verify <patch>` (and deterministic patch authoring) | **adapted** | CodeCitadel separates patch verification from unverified auto-edits; verification runs in disposable copy. |
| `fixmyslop hook` | Claude Code PostToolUse JSON hook | Planned in integrations package (`packages/integrations`) | **planned** | Integration hook to be added in Phase 7. |
| `fixmyslop init` | Installs project rules/configs for Cursor, Claude, CI | Planned `codecitadel init` | **planned** | Scaffolding for `.codecitadel.json`, requirement templates, and CI actions. |
| `fixmyslop ui` | Local web app on 127.0.0.1 with interactive HTML dashboard | `codecitadel serve` (Phase 7 / R2: Fastify API + Vite/React workbench) | **planned** | Hosted and local dashboard using shared contracts and SSE streaming. |
| *(CodeCitadel addition)* | N/A | `codecitadel impact [path] --base <file>` | **implemented** | Computes TypeScript module graph and test reachability chains. |
| *(CodeCitadel addition)* | N/A | `codecitadel run [path] --base <file>` | **implemented** | Supervised Vitest execution in disposable copy with per-test normalized results. |
| *(CodeCitadel addition)* | N/A | `codecitadel compare --before <a> --after <b>` | **implemented** | Before/after execution report comparison by test fingerprint. |
| *(CodeCitadel addition)* | N/A | `codecitadel requirements list\|accept\|check` | **implemented** | Declarative requirements with SHA-256 acceptance digests. |
| *(CodeCitadel addition)* | N/A | `codecitadel reproduce run\|export` | **implemented** | Declared check reproduction in disposable copy and portable test export. |
| *(CodeCitadel addition)* | N/A | `codecitadel demo coupon-race` | **implemented** | End-to-end race condition reproduction and patch verification against PostgreSQL. |
| *(CodeCitadel addition)* | N/A | `codecitadel evidence export` & `codecitadel replay` | **implemented** | Self-contained, tamper-evident evidence bundles and isolated replay. |

---

## Rule Inventory & Parity Mapping

### 1. Security Rules (`fixmyslop/core/slop/rules_security.py`)

| Upstream Rule ID | Description | Severity | CodeCitadel Equivalent | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| `sec/leaked-key` | Leaked API key / private key | CRITICAL | `security/exposed-aws-credential` + secret patterns in scanner | **implemented** | Native Rust scanner matches secret patterns and redacts evidence snippets. |
| `sec/hardcoded-credential` | Hardcoded password / secret | HIGH | Native scanner text rule `security/exposed-aws-credential` | **partial** | AWS keys covered; generic credential pattern expansion planned. |
| `sec/env-secret` | Secrets in committed .env file | HIGH | Git discovery ignore policy (rules ignore `.env` by default) | **implemented** | Scanner discovers files using Git ignore rules; fails if `.env` unignored. |
| `sec/public-env-secret` | Secret with `NEXT_PUBLIC_` / `VITE_` prefix | HIGH | Scanner text pattern | **planned** | Straightforward regex rule for native scanner. |
| `sec/sql-injection` | String-interpolated SQL | HIGH | Planned AST rule | **planned** | Best implemented with AST traversal to reduce false positives. |
| `sec/cors-wildcard` | CORS wildcard allow-all origins | MEDIUM | Scanner rule | **planned** | Text rule in scanner. |
| `sec/tls-disabled` | TLS verification override / disabled | HIGH | `security/tls-verification-disabled` | **implemented** | Detected in native Rust scanner (`rules.rs`), verified in `fixtures/security`. |
| `sec/raw-html` | Raw HTML injection (`dangerouslySetInnerHTML`) | MEDIUM | `security/dangerously-set-inner-html` | **implemented** | Detected in native Rust scanner (`rules.rs`), verified in `fixtures/security`. |
| `sec/eval` | `eval` / `new Function` invocation | HIGH | Scanner text rule | **planned** | Text rule in native scanner. |
| *(CodeCitadel addition)* | `security/shell-enabled-subprocess` | MEDIUM | `security/shell-enabled-subprocess` (`child_process.exec`, `shell: true`) | **implemented** | Detected in native Rust scanner, prevents shell injection risks. |

### 2. Code Slop Rules (`fixmyslop/core/slop/rules_code.py` & `rules_backend.py`)

| Upstream Rule ID | Description | Severity | CodeCitadel Equivalent | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| `slop/debugger` | Debugger statement left in code | HIGH | Scanner text rule | **planned** | Text rule in native scanner. |
| `slop/console-log` | `console.log` left in production code | LOW | Scanner text rule | **planned** | Text rule in native scanner. |
| `slop/emoji-log` | Emoji characters in log statements | LOW | Scanner text rule | **planned** | Text rule in native scanner. |
| `slop/ts-ignore` | `@ts-ignore` diagnostic suppression | LOW | `patch-verification.ts` weakening detector | **implemented** | Detected during patch verification as a weakening signal. |
| `slop/blanket-suppression` | Whole-file eslint / type suppression | MEDIUM | `patch-verification.ts` weakening detector | **implemented** | Detected during patch verification as a weakening signal. |
| `slop/empty-catch` | Empty catch block swallowing errors | MEDIUM | Scanner text / AST rule | **planned** | AST rule in TS engine. |
| `slop/empty-test` | Test with no assertions | MEDIUM | `patch-verification.ts` assertion counter | **partial** | Weakening detector checks added vs removed assertions. |
| `slop/todo-reminder` | TODO / FIXME comment left in code | INFO | `general/todo-comment` | **implemented** | Detected in native Rust scanner (`rules.rs`). |

### 3. UI Slop & Accessibility (`fixmyslop/core/slop/rules_ui.py`)

| Upstream Rule ID | Description | Severity | CodeCitadel Equivalent | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| `a11y/img-alt` | Image missing `alt` attribute | MEDIUM | axe-core adapter | **planned** | Integrated via axe-core in Phase 6/7 browser checks. |
| `a11y/clickable-div` | Clickable `<div>` without role or keyboard handlers | MEDIUM | axe-core adapter | **planned** | Evaluated via axe-core. |
| `a11y/icon-button` | Icon-only button lacking accessible name | MEDIUM | axe-core adapter | **planned** | Evaluated via axe-core. |
| `a11y/focus-removed` | `outline: none` removing focus visibility | MEDIUM | axe-core adapter | **planned** | Evaluated via axe-core. |
| `ui/fake-ratings` / `fake-social-proof` | Hardcoded ratings and review stats | MEDIUM | Scanner text heuristic | **planned** | Regex heuristic. |
| `ui/placeholder-copy` | "Lorem ipsum", "Title goes here" in UI | HIGH | Scanner text heuristic | **planned** | Regex heuristic. |

---

## Parity Milestones & Backlog

1. **Phase 1 / R0–R1 (Current):** Focus on correctness, zero-trust verification, immutable change snapshots, isolated execution, deterministic patch verification, and replayable evidence. Core security rules implemented in native Rust scanner.
2. **Phase 2 (Parity Foundation):** Migrate the text pattern heuristics from `rules_code.py` and `rules_ui.py` into native Rust rules in `crates/scanner-core/src/rules.rs`.
3. **Phase 7 (Workspaces & Reports):** HTML and PDF reporting formats, interactive workbench UI, and IDE / agent integrations.
