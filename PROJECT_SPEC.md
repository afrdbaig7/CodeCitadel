# Project naming decision ? 21 October 2026

The project is named **CodeCitadel**, as directed by the owner. References to
PatchProof below preserve the original specification; use `codecitadel`,
`@codecitadel/*`, `codecitadel-scanner`, and `CODECITADEL_SCANNER_BIN` in the
implementation. Public package, domain, and trademark availability is unverified.

---

# PatchProof: TypeScript + Rust implementation prompt for a real-user release

Prepared 19 October 2026. This is a build specification and reusable prompt, not a claim that the software already exists. “PatchProof” is a working name: another project already documents a CLI with that name. Verify npm, GitHub, domain, and relevant naming conflicts before publishing. Do not assert availability.

## How to use this prompt

Give the entire document to your coding agent in a new repository. Keep it as `PROJECT_SPEC.md`, and ask the agent to read it at the start of each session. Begin with Phase 0, then implement one runnable milestone at a time. Use the continuation instruction at the end when resuming. Do not ask an agent to generate the whole platform in one response.

Revision 3, updated 21 October 2026: use TypeScript for the platform and semantic verification engine, and Rust for a focused repository scanner. Do not add Go. Ship an independently useful CLI and user-controlled verification first, then an authenticated hosted dashboard, then a managed execution service after its security gates. Both local and hosted modes use the same analysis engine and evidence contracts. Sections 28–30 define the Rust implementation and current release sequence; they take precedence over earlier sequencing where they differ. Billing is optional later work; do not make the local engine depend on an account or hosted service. All architecture, code, and tests requested here are intended for the open-source project unless a later explicit decision changes that scope.

---

## START OF MASTER BUILD PROMPT

You are my senior TypeScript and Rust engineer, application-security engineer, testing specialist, and programming mentor. Build PatchProof with me as a maintainable open-source project that real developers can install and use. Make real changes in the repository, run appropriate checks, and explain the important code. Do not produce a dashboard with simulated results and present it as a working verification engine.

### 1. Product and engineering goals

PatchProof is a comprehensive code-quality and change-verification platform inspired by FixMySlop. Its main question is: “What changed, what could break, and what evidence do we have?”

Retain the original project's capabilities through a documented parity plan: UI patterns, accessibility, code quality, security, dependencies, documentation, configuration, custom rules, baselines, scoring, reports, integrations, and optional AI review. Confirm the exact original capabilities by inspecting its source and documentation at a recorded commit. These category names do not establish parity by themselves.

Extend that foundation with change impact analysis, accepted requirement checks, bug reproduction, mutation-based test-strength checks, and isolated patch verification. Deep behavioral verification targets TypeScript/JavaScript first. Other languages are supported through adapters with explicit capability limits.

The standalone edition must work usefully without an AI provider, an account, or internet access after dependencies and execution images are available. Hosted mode requires authentication and its infrastructure. Security and dependency intelligence may be stale offline: expose dataset dates and unavailable checks. Never interpret unavailable services as clean results. Design for horizontal API scaling and independently scalable verification capacity; establish actual capacity with load tests rather than claiming support for an arbitrary user count.

Prioritize correctness, reproducible evidence, a fast CLI, a contributor-friendly codebase, and low-noise reports. Do not promise formal correctness, complete call graphs, guaranteed race detection, or universal automatic test generation.

### 2. Teaching and working agreement

I want to understand what I build. Work in small vertical slices rather than generating hundreds of files.

Before each milestone:
- Explain the behavior we are adding, its inputs and outputs, and where it belongs.
- List the files to create or edit and each file's responsibility.
- Explain new dependencies and why existing platform APIs are insufficient.
- Describe a concrete acceptance check.

During implementation:
- Use readable names, small functions, explicit boundaries, and ordinary control flow.
- Explain non-obvious lines, types, SQL, AST traversal, concurrency, process handling, and security decisions.
- Keep explanations in learning notes rather than filling code with redundant comments.
- Record how execution moves between files, including the error path.
- Offer a small exercise and two or three comprehension questions; do not block authorized work waiting for answers.

After each milestone:
- Run the relevant checks and show actual results, failures, and remaining limitations.
- Update `docs/progress.md` and `docs/learning/phase-N.md`.
- Provide a runnable command and an example of the expected output, labeled as an example if not captured from execution.
- Stop at the milestone boundary with a concrete next task. Do not imply later phases are implemented.

Avoid routine permission questions, unnecessary abstractions, and speculative infrastructure. Ask only when a missing answer materially changes scope or could cause destructive work. Preserve existing user changes.

### 3. Chosen technology stack

There is no universally best stack. Use this baseline for a scalable hosted service and standalone developer tool, and record changes in architecture decision records. The hosted architecture is a modular application with separate orchestration workers and untrusted execution sandboxes, not dozens of microservices.

| Area | Default | Reason / boundary |
| --- | --- | --- |
| Runtime | Node.js 24 LTS, supported patch pinned at setup | Stable ecosystem for analyzers and test tooling; verify actual current support before installation |
| Language | Stable TypeScript, strict mode, ESM | One implementation language across engine, CLI, server, and UI |
| Native scanner | Stable Rust, Cargo workspace, pinned toolchain and Cargo.lock | File discovery, ignore handling, content hashing, bounded text scanning; versioned subprocess protocol |
| Workspace | pnpm workspaces + Turborepo | Package boundaries, reproducible installs, task ordering, build caching |
| Build | `tsc` for declarations/buildable packages; Vite for dashboard | Prefer predictable builds over unnecessary bundler layers |
| CLI | Commander; minimal terminal formatting | Scriptable interface with separate human and JSON output |
| Contracts | Zod with exported versioned JSON schemas | Validate configuration, API input, provider output, and stored reports |
| Analysis | TypeScript Compiler API through ts-morph where helpful | Symbol-aware references and AST analysis; use lower-level APIs only where measured needs justify them |
| Hosted API | NestJS with Fastify adapter, OpenAPI, SSE | Modules, dependency injection, authorization, stateless API replicas |
| Local API | Thin Fastify server | Account-free local UI; same engine and contracts |
| Dashboard | React + Vite + TanStack Router/Query | CDN-served hosted app or static local app; SSR is unnecessary for the workbench |
| UI | Tailwind CSS, accessible Radix/shadcn components, Lucide | Accessible, maintainable UI primitives with an original layout |
| Source viewer | Monaco Editor, lazy loaded | Read-only source, diffs, diagnostics, evidence links |
| Local persistence | SQLite + Drizzle ORM + better-sqlite3 | Embedded storage, explicit migrations; test native-module packaging on supported systems |
| Hosted persistence | PostgreSQL + Drizzle + PgBouncer | Tenant-aware relational records, bounded pools, explicit hosted migrations |
| Durable orchestration | Temporal with supported TypeScript SDK | Multi-step verification, retries, deadlines, cancellation, recovery |
| Cache and distributed limits | Valkey | Ephemeral tenant-scoped caches and rate limits; never the sole source of durable run state |
| Hosted artifacts | S3-compatible object storage | Reports, source snapshots, traces, patches, large logs; encrypted and access controlled |
| Identity | OIDC/OAuth integration with an established identity provider | Hosted sign-in and organization membership; do not implement password cryptography |
| Unit/integration tests | Vitest | Primary runner for PatchProof and first repository adapter |
| Additional repository runner | Jest adapter | Support target projects without forcing migration |
| Properties/state models | fast-check | Seeded generation, shrinking, model-based tests |
| Mutation testing | StrykerJS + runner adapters | Reuse mature mutation tooling and incremental capabilities |
| Browser/a11y | Playwright + axe-core | Browser evidence and scoped accessibility checks |
| Process execution | Node spawn with argument arrays and a supervised executor | Shell-free invocation, timeouts, cancellation, bounded output |
| Local isolation | Docker/Podman runner abstraction | Disposable local execution with documented limitations |
| Hosted isolation | Disposable sandboxes; gVisor-backed Kubernetes Jobs as the initial production target | Separate execution node pool, network restrictions, quotas; validate runtime/tool compatibility and residual risks |
| AI | Small provider interface; official provider SDKs or HTTP | Hosted and local OpenAI-compatible/Ollama adapters; no unnecessary agent framework |
| MCP | Current supported official TypeScript SDK | Tool interface over the same engine; verify SDK package/API at setup |
| Observability | Pino + OpenTelemetry + Prometheus/Grafana + centralized logs | Request/run traces, queue and worker metrics, redaction, bounded metric cardinality |
| Delivery | Docker, Terraform, GitHub Actions; Kubernetes manifests/Helm for production target | Reproducible infrastructure and staged rollouts; Compose for contributor development |
| Reports | Shared report model; JSON, Markdown, SARIF first | HTML/CSV/PDF added progressively without changing engine semantics |
| Git | Git executable through safe argument arrays | Avoid shell interpolation; resolve and validate refs |
| Quality | ESLint with typescript-eslint, Prettier, dependency update automation | Use one consistent lint/format system |
| Releases | Changesets + GitHub Actions + npm trusted publishing where supported | Reviewed versioning and repeatable releases |
| Documentation | Markdown + Mermaid; optional VitePress later | Keep contributor onboarding lightweight |

PostgreSQL and private object storage are required for the hosted dashboard. Temporal and separate orchestration workers are required when implementing managed asynchronous verification. Kubernetes is the later production execution target when its scheduling and isolation capabilities are needed. The initial user-controlled execution release does not require that cluster or Temporal on every user's machine. Do not add Go, Kafka, Elasticsearch, a vector database, a second durable queue, or a multi-agent framework without an explicit scope change. Rust has the narrow scanner role defined in section 28; it is not a second API backend or replacement TypeScript type checker. Keep hosted infrastructure dependencies outside standalone CLI installation.

Choose compatible stable package versions from official documentation at implementation time. Pin direct dependencies, commit `pnpm-lock.yaml`, pin the package-manager version, and record the compatibility matrix. Do not invent APIs or assume every latest major interoperates. Configure Node-targeted packages and browser packages appropriately rather than sharing one incompatible tsconfig.

### 4. Monorepo and dependency rules

Use this target structure, creating packages only when their phase needs them:

```text
apps/
  cli/
  local-server/
  api/
  orchestration-worker/
  sandbox-runner/
  dashboard/
  mcp-server/
packages/
  contracts/
  core/
  rules/
  language-adapters/
  repo-context/
  impact-analysis/
  requirements/
  reproduction/
  mutation/
  patch-verification/
  execution/
  storage/
  ai/
  reports/
  integrations/
  behavior-packs/
  workflows/
  tenancy/
  auth/
  artifact-storage/
  observability/
  scanner-client/
crates/
  scanner-core/
  scanner-cli/
infra/
  compose/
  terraform/
  kubernetes/
examples/
  shopping-api/
  clean-api/
fixtures/
  analysis/
  security/
  regressions/
benchmarks/
docs/
  adr/
  learning/
  architecture.md
  parity.md
  threat-model.md
  capability-matrix.md
  progress.md
```

`contracts` owns serializable models and runtime validation. Feature packages depend on contracts and narrow interfaces, not on frontend or transport packages. `core` orchestrates feature services through dependency injection. Execution and storage implementations are wired at application entry points. Avoid circular dependencies and a giant `core` package that contains every algorithm.

CLI, server, MCP, and CI invoke the same engine entry points. Hosted API requests submit durable workflow intents; orchestration workers invoke the engine and create isolated execution jobs. Reports consume the same serialized report. The UI cannot invent results or reimplement analysis. Keep React, NestJS, Fastify, SQLite, PostgreSQL, Temporal, Docker clients, and provider SDKs out of domain contracts. Temporal workflow code imports deterministic contracts and orchestration logic only; side effects belong in activities. Never run repository code in API or Temporal worker processes.

### 5. Core data contracts

Define Zod-backed schemas and inferred TypeScript types for RepositorySnapshot, ChangeSet, SymbolReference, ImpactGraph, Finding, AcceptedRequirement, CheckPlan, CheckResult, ExecutionRecord, MutationResult, PatchProposal, VerificationRun, EvidenceBundle, Baseline, and AdapterCapabilities.

Required concepts:
- Stable IDs and schema versions. A finding fingerprint should survive unrelated line insertions where practical; include a migration/version strategy for fingerprint changes.
- Source locations, rule ID/version, category, severity, explanation, remediation, references, and provenance.
- Separate evidence status (`suspected`, `reproduced`, `unable_to_verify`) from check execution status (`passed`, `failed`, `skipped`, `timed_out`, `errored`, `cancelled`, `unsupported`).
- Accepted requirements have stable IDs, explicit expectations, acceptance provenance, check mappings, and revision history. AI-generated suggestions remain unaccepted.
- Evidence records capture exact repository identity, base/head hashes, dirty-worktree snapshot digest, patch digest, lockfile digest, tool/runtime versions, container image digest, parameters, seed, command arguments, exit status, duration, artifacts, and limits.
- Preserve raw tool results separately from normalized findings. Redact before persisting or displaying secrets.
- Report unverified scope and why a check was omitted. Never turn a missing check into a pass.
- Include expected behavior source: accepted criterion, maintained contract, user-authored invariant, or a clearly labeled differential observation.

Keep severity, confidence, reproduction status, and scope independent. Do not calculate a probability that the whole patch is correct. Quality scores must have a documented formula, weights, exclusions, and coverage limits; scores do not replace findings.

### 6. Shared engine and rule API

Implement a typed engine facade with operations for scanning, impact planning, check execution, reproduction, patch verification, report retrieval, and evidence replay. Return structured results; emit progress events; accept AbortSignal and resource budgets.

Use a rule contract along these lines, refining types as needed:

```ts
interface Rule {
  metadata: RuleMetadata;
  check(context: RuleContext): AsyncIterable<Finding>;
  proposeFix?: (finding: Finding, context: RuleContext) => Promise<PatchProposal | undefined>;
}
```

Rules declare language/framework support, options schema, execution requirements, and fix safety classification. Keep scan operations read-only. Avoid presenting a code-execution configuration file or third-party plugin as passive data. Safe default configuration is declarative JSON/YAML with schema validation; programmatic TypeScript configuration requires explicit trusted-repository mode.

Honor `.gitignore`, explicit exclusions, generated/vendor files, size limits, symlinks, and inline suppressions with reasons. Detect duplicates across analyzers and support baselines with expiry and ownership metadata. Report new, existing, resolved, and suppressed findings separately.

Delegate established checks where practical: ESLint/TypeScript, axe-core, dependency auditing, secrets scanning, and selected security analyzers. Verify each external tool's installation, license, output format, and offline requirements. Do not claim an external tool is bundled when it is merely supported.

### 7. FixMySlop parity and attribution

Inspect `https://github.com/MrSpideyNihal/FixMySlop` at a pinned commit. Produce `docs/parity.md` with one row per actual rule, CLI command, configuration behavior, report format, and integration workflow.

Columns: upstream source reference, behavior, PatchProof implementation/adaptation, fixture, validation, status, known differences, license/provenance.

Mark items implemented, partial, planned, intentionally different, or blocked. Do not claim full parity until every applicable row is verified. Inspect upstream license and notices before copying or adapting code. Record provenance and comply with actual terms; do not assume a license. Write original modules where appropriate, and acknowledge inspiration in README and documentation. If license compatibility is unresolved, implement independently and record the limitation rather than deleting attribution.

### 8. Repository snapshots and impact analysis

Support committed branch comparisons, staged changes, and dirty working trees. Preserve staged versus unstaged distinctions, renames, deletions, binary files, and untracked files selected by policy. Use immutable snapshots for verification; never mutate the user's checkout to execute a patch.

Resolve tsconfig files, workspace/package boundaries, path aliases, module exports, and project references. Build a graph of symbols, imports/exports, callers, routes, and test relationships. Start with explicit TypeScript imports and direct calls, then add framework adapters.

For every selected test or affected endpoint, show an explanation path such as changed function → caller → route → test. Label heuristic edges and unknown dynamic relationships. Configuration, dependency, schema, route-registration, or global setup changes must trigger broader fallback checks when precise selection is unsafe.

Incremental caches include snapshot contents, dependencies, accepted requirements, configuration, analyzer versions, runner versions, environment, and relevant tool options. Never reuse verification evidence across incompatible cache identities. Distinguish analysis caches, dependency caches, and execution-result caches.

### 9. Test discovery and execution

Implement Vitest first, then Jest. Discover tests and configuration in an isolated process; test configuration itself may execute code. Normalize test IDs, assertions, suite errors, exit codes, coverage, durations, and logs. Use machine-readable reporters instead of fragile terminal parsing where supported.

Run baseline checks before evaluating a candidate repair. Distinguish a pre-existing failure, a failure introduced by the change, a broken environment, and a check that never ran. If the baseline is broken, affected claims remain inconclusive unless a narrower valid comparison is possible.

Quick mode: changed-file static checks and conservative selected tests. Deep mode: broader tests, accepted properties, reproductions, mutation testing, browser/API checks within budget. Always expose the selected scope. Respect `--budget`, `--max-workers`, output limits, cancellation, and optional provider spending limits. Do not hide incomplete deep runs behind a successful summary.

### 10. Acceptance criteria and behavior packs

Store requirements as declarative, versioned documents. Example:

```yaml
version: 1
requirements:
  - id: coupon.single-redemption
    statement: A coupon can be redeemed only once per user.
    state: accepted
    checks:
      - coupon-first-use
      - coupon-repeated-use
      - coupon-concurrent-use
```

Map statements to registered executable checks with validated parameters and setup hooks. Acceptance requires an explicit user action or a committed accepted contract. Natural-language inference cannot approve its own requirements.

For token expiry, test first use, replay, just-before expiry, the specified boundary, and after expiry. Make clocks injectable; record timezone and time origin. Do not infer whether exactly fifteen minutes is inclusive or exclusive.

Build a behavior-pack SDK for authorization, token lifecycle, idempotency, webhooks, transactions, and pagination. Require projects to map operations, fixtures, and intended semantics. Never attach generic financial or authorization expectations without an accepted contract.

### 11. Reproduction and counterexamples

Reproduction pipeline: suspected finding → expected-behavior source → bounded test proposal → schema and safety validation → isolated execution → outcome classification → optional minimization → evidence bundle.

AI can propose test source but cannot declare that the bug exists. Inspect generated tests for meaningless assertions, unexpected network/filesystem access, test skipping, and dependence on implementation mistakes as the oracle. These checks supplement isolation; they do not prove generated code safe or correct.

Use fast-check for seeded properties, shrinking, and stateful models when applicable. Minimize request payloads or action sequences while repeatedly preserving the same failure predicate. Save seeds and replay paths. A failed setup is not a reproduced bug. Flaky outcomes are reported with repetitions and observed rates, not silently promoted to deterministic evidence.

Export regression tests as ordinary Vitest/Jest project tests. Do not require PatchProof's internal packages to execute them unless an explicit optional helper is necessary and documented.

### 12. Mutation-based test strength

Integrate StrykerJS rather than implementing a general mutation engine. Start with changed-code mutation and supported runners. Track killed, survived, no coverage, timed out, compile error, ignored, and unsupported outcomes according to the adapter's actual semantics.

Surviving mutants indicate potential test gaps; equivalent mutations and unreachable behavior require triage. Timeouts are not evidence of a killed mutant unless the tool explicitly distinguishes its detection semantics and the report explains them. Include denominator and exclusions in any mutation score.

Custom ownership-check or transaction mutants are experimental, narrowly scoped operators with positive and negative fixtures. Never modify the user's original source. Preserve the mutation diff and test evidence for each reported gap.

### 13. Patch proposals and verification

Separate deterministic fixes from AI proposals. Neither is automatically verified because its author labels it safe.

For each proposal:
1. Capture the immutable source snapshot and original failing reproduction.
2. Create a disposable worktree/copy and isolated runtime.
3. Validate patch paths and apply only within the snapshot root.
4. Rerun the unchanged original reproduction against the patch.
5. Run selected regressions, accepted checks, type checks, and relevant rescans.
6. Inspect modifications to tests, assertions, exclusions, tooling configuration, dependency locks, and accepted requirements.
7. Produce before/after results, exact patch, limits, and remaining unverified checks.
8. Clean up resources even on cancellation or crashes.

A patch that deletes the reproduction or weakens the requirement cannot earn a passing result for the original contract. Store verification tests outside candidate-controlled files where practical. A new scan finding and a baseline failure must remain visible.

Applying to the user's checkout is an explicit separate command, with snapshot/hash freshness checks and conflict handling. Never silently overwrite dirty files or automatically merge/push.

### 14. Execution threat model

Target repositories, package scripts, analyzers, generated tests, AI output, plugins, and evidence bundles can be untrusted. Read-only scanning must not execute repository code by default. Separate passive analysis, dependency acquisition, and test execution modes.

The host orchestrator alone controls the container runtime. Target code must not receive the Docker socket, host credentials, home directory, SSH agent, or cloud environment variables. Use non-root execution, dropped capabilities, no privileged mode, read-only root where possible, bounded writable workspaces/tmpfs, CPU/memory/process/output/wall-time/disk limits, and platform-appropriate seccomp/runtime controls. Document unsupported controls on each OS.

Disable external network during verification by default. Database-dependent demos may use a dedicated internal-only network with disposable services and fixture credentials. Dependency acquisition is a distinct, logged, controlled network-enabled phase. A package manager install may run lifecycle scripts; disable them by default and require a documented policy for needed scripts. Do not silently fall back from isolation to host execution.

Containers reduce risk but are not a complete hostile-code security boundary. Hosted arbitrary-code execution is explicitly in scope and must pass a separate threat model and isolation readiness gate before accepting public repositories. Use the hosted controls in section 24. Do not expose the local runner as a public execution service or describe Kubernetes alone as sufficient isolation.

Handle archive traversal, symlink escape, path traversal, option injection, malicious refs, shell injection, and cleanup races. Validate input paths, separators, and resolved roots. Use argument arrays and `--` where applicable. Kill descendant processes and reconcile interrupted jobs on startup.

### 15. Local API and persistence

Bind to loopback by default. Serve the built dashboard from the local server. Protect sensitive actions with an ephemeral local session token; verify Host/Origin and apply CSRF protections appropriate to the chosen transport. Do not allow arbitrary cross-origin requests. Restrict repository roots and file APIs; never expose a general shell endpoint.

Version routes under `/api/v1`, including repositories, scans, changes, check plans, runs, cancellation, findings, patch proposals, and evidence exports. Validate request and response contracts. Stream typed events through SSE with run/event IDs, reconnect behavior, and bounded retention.

SQLite stores repositories, snapshots, runs, checks, findings, baselines, requirements, patch metadata, artifact references, and migration state. Store large artifacts in an application-controlled content-addressed directory. Use WAL and serialized writes where appropriate. Reconcile database state and artifacts after interruptions. Provide retention and deletion commands.

Run state machine: queued → preparing → running → completed/failed/cancelled, with check-level statuses preserved. Jobs must be cancelable and idempotently submitted using explicit request identities. Persisted run IDs must distinguish separate execution attempts; content hashes identify inputs/artifacts, not fabricated timestamps or identical real-world outcomes.

### 16. CLI contract

Implement commands progressively, documenting only those that exist:

```text
patchproof init
patchproof doctor
patchproof scan [path]
patchproof changes --base <ref>
patchproof check --base <ref> --mode quick
patchproof verify --base <ref> --budget 5m
patchproof reproduce <finding-id>
patchproof mutate --changed
patchproof patch propose <finding-id>
patchproof patch verify <proposal-id>
patchproof patch apply <proposal-id>
patchproof requirements list|accept
patchproof baseline create|update
patchproof report <run-id> --format json|markdown|sarif|html|csv|pdf
patchproof evidence export <run-id>
patchproof replay <bundle>
patchproof serve
patchproof demo coupon-race
```

All commands need help, validated arguments, stable JSON output, and useful errors. Machine-readable output goes to stdout; diagnostics/progress go to stderr. Support no-color/noninteractive usage, cancellation, Windows paths, and safe ref handling. Replay must validate bundle schema, artifact hashes, size limits, and execution permissions before running anything.

Define exit semantics explicitly: 0 means the requested policy was satisfied; 1 means findings/check failures breached policy; 2 means invocation/infrastructure error or a required inconclusive check. Report actual check statuses in all cases. Distinguish user cancellation using conventional signal behavior where supported. A static scan exit 0 does not claim behavioral verification occurred.

`doctor` explains missing Git, container runtime, images, analyzers, runner support, provider settings, and platform restrictions. Optional missing tools should not break unrelated capabilities.

### 17. Dashboard and reports

Build the dashboard only after a working CLI verification slice exists. Use four workspaces:
- Repository: findings, configuration, dependency health, baselines, history, and documented quality score.
- Changes: diff, accepted requirements, affected symbols/routes/tests, selected checks, uncertainty.
- Verification: reproductions, properties, mutations, test results, resource usage, logs.
- Repairs: patch proposals, diff, before/after evidence, verification limits, explicit apply action.

Use file navigation, a source/diff viewer, and an evidence panel. Make the primary result understandable before showing raw traces. Include loading, empty, partial, failed, offline, cancelled, and unsupported states. Keyboard access, accessible labels, focus management, contrast, reduced motion, and responsive behavior are required.

No fabricated test counts, hardcoded passing states, invented histories, fake performance percentages, or ambiguous demo evidence. Recorded demo data must be labeled recorded and traceable to a real run; simulations remain labeled simulations.

All renderers consume one report contract. SARIF follows the actual schema and preserves rule/source identities. CSV resists spreadsheet formula injection. Escape HTML/Markdown appropriately, bound artifact sizes, and redact secrets. Generate PDF from trusted report templates, not executable repository HTML. The CLI remains usable without installing browser dependencies for PDF or UI checks.

### 18. AI and integrations

Provider contract: structured request/response, cancellation, deadlines, token/cost budgets where available, model/provider identifiers, input disclosure, and redaction. Remote source transfer must be explicit opt-in. No automatic fallback from a local provider to a hosted provider. Treat repo text and tool output as untrusted data, not instructions with authority over the agent.

AI may suggest findings, requirements, reproductions, and patches. Only actual checks establish execution outcomes. Record model and prompt-template versions where used. Keep core scanning and demo usable without AI.

GitHub Actions integration must run the same engine, upload evidence artifacts, publish concise job summaries, and document fork permissions. Do not execute untrusted PR code with privileged `pull_request_target` credentials. Publishing a check summary should not expose repository secrets or generated payloads. Pin third-party action revisions and review required permissions.

MCP tools should expose bounded operations such as scan, explain impact, get evidence, propose reproduction, and verify patch. Separate read-only capabilities from execution and write operations. An MCP connection does not independently authorize arbitrary code execution or file modification.

Provide pre-commit quick mode, documented agent usage, and machine-readable results. Do not add a hosted GitHub App before the CLI/Action workflow is solid. Later VS Code support should remain a thin engine client.

### 19. Signature demonstration

Create a real TypeScript shopping API with Fastify, a disposable PostgreSQL database, migrations, and Vitest tests. The demo database must be separate from hosted platform storage, with independent credentials and no access to platform data. The standalone CLI still uses SQLite.

Accepted rule: a particular coupon can be redeemed at most once per user. Include a deliberately vulnerable check-then-insert flow and a valid first-redemption test. Record the requirement and fixture assumptions.

Run simultaneous requests against the real database using a synchronized harness, repetitions, and state assertions. To make the demonstration repeatable, an explicitly labeled test hook may hold requests at the vulnerable boundary; also run an ordinary concurrency stress check separately. Never represent an injected schedule as naturally discovered production frequency.

When duplicate redemption is observed, retain request IDs, schedule/seed where applicable, HTTP responses, and database evidence. Propose a composite uniqueness constraint on user/coupon, a migration that handles existing duplicate data explicitly, transactional behavior as required, and appropriate conflict handling.

Verify the original reproduction against the patch, plus first use, repeated use, independent users, rollback behavior, and the relevant existing suite. Show exact attempts and outcomes. If zero duplicates occur after a finite run, say that none were observed in that run; do not claim all schedules are proven safe.

The deterministic demo patch may be pre-authored and labeled as such. AI-generated proposals are an optional separate path. A working offline demonstration must not depend on a model guessing the right database fix.

### 20. Validation strategy

Test real risks and interfaces, not implementation-shaped mocks alone:
- Rule fixtures include true positives, clean controls, comments/strings, suppressions, generated code, and malformed inputs.
- Impact fixtures include aliases, re-exports, overloads, monorepos, deleted symbols, configuration changes, and dynamic unknowns.
- Runner contract tests cover pass/fail, setup error, no tests, timeout, cancellation, noisy output, and incompatible versions.
- Sandbox tests cover path escape, environment leakage, resource exhaustion, cleanup, and prohibited network access where the platform supports enforcement.
- End-to-end tests run CLI → snapshot → engine → isolated check → persisted report → replay.
- API/UI tests validate real engine results and states; separately labeled fixtures may test presentation edge cases.
- Property tests exercise normalization, hashing, patch boundaries, and state-machine invariants where useful.
- Benchmark corpora include real or carefully authored buggy changes, fixed changes, clean controls, intentional behavior changes, and broken environments, each with provenance.

Publish per-category detection results, false-positive definitions, runtime, hardware, versions, seeds, cost where used, exclusions, and sample size. Use independent or held-out cases to reduce tuning to the demonstration. Do not invent a benchmark leaderboard or compare competitors without a reproducible method.

### 21. Open-source release requirements

Select a permissive license for original code, subject to actual upstream/dependency obligations, and document the choice. Include README, contribution guide, code of conduct, security reporting policy, changelog, architecture docs, parity matrix, support matrix, and third-party notices.

README includes a concise pitch, real recording, prerequisites, one-command demo, a useful no-AI scan, limitations, examples, and contribution entry points. CLI installation must work from a packed release artifact, not only within the monorepo.

CI runs typecheck, lint, unit/integration checks, representative end-to-end checks, packaging smoke tests, and appropriate dependency/license checks. Test supported Linux, macOS, and Windows installation paths, while documenting which isolation checks require containers or Linux features. Do not claim platform support from a single successful typecheck.

Use Changesets, semantic versions, npm package exports, release provenance where supported, a public changelog, and repeatable publishing. Avoid publishing credentials, fixtures with real secrets, or evidence containing private code. Use opt-in telemetry only, with a documented schema; default to no telemetry.

Provide a small contributor task template for adding a rule, adapter, behavior pack, or renderer. Keep a capability matrix with implemented/experimental/planned/unsupported states. A feature in this specification is not a released capability until validated.

### 22. Phased implementation and exit gates

**Phase 0 — Grounding and decisions**
Inspect the workspace and upstream. Deliver product scope, pinned upstream inventory, dependency/version choices, license/provenance notes, threat model, ADRs, parity matrix, support matrix, and milestone plan. Resolve a practical working package scope without asserting public naming availability. Do not build the dashboard first.

**Phase 1 — Small usable scanner**
Create workspace tooling, contracts, core orchestration, read-only repository discovery, rule API, a small representative set of original rules, CLI scan, and JSON/Markdown/SARIF output. Gate: a packed CLI scans both clean and faulty fixtures without executing their code; rules and errors have machine-readable output.

**Phase 2 — Parity foundation and storage**
Implement the documented parity backlog in bounded slices: configuration, suppression, baseline, deduplication, score/report compatibility, analyzer adapters, history, and deterministic fix proposals. Gate: each implemented parity row has evidence; remaining gaps are explicit. Do not postpone every verification milestone until a large parity backlog is complete; continue the vertical slice while progressing parity.

**Phase 3 — Changes, impact, and test execution**
Implement immutable snapshots, diff parsing, TS symbol graph, conservative test selection, isolated executor, Vitest adapter, run storage, cancellation, and before/after comparison. Gate: an actual branch change triggers explained test selection and a normalized execution report; environment failures remain inconclusive.

**Phase 4 — Accepted requirements and reproduction**
Implement requirement acceptance, registered checks, first behavior packs, property generation, reproduction statuses, regression export, and replayable evidence. Gate: a real failing case replays and the exported test runs independently.

**Phase 5 — Verified patches and coupon demo**
Implement isolated patch application, original-reproduction rerun, regression checks, configuration/test weakening detection, patch freshness checks, and the real shopping API demonstration. Gate: a vulnerable case fails, a labeled proposal repairs it under the performed checks, and the report retains unverified scope.

**Phase 6 — Mutation and stronger testing**
Add StrykerJS adapters, changed-code scope, incremental reporting, counterexample shrinking, stateful packs, and concurrency harness improvements. Gate: a deliberately weak test suite has a visible surviving mutant and an improved suite kills that mutant under the same setup.

**Phase 7 — Real dashboard and integrations**
Implement the thin local Fastify API/SSE, four UI workspaces, Monaco viewer, GitHub Action, pre-commit, MCP, HTML/CSV/PDF renderers, and optional AI adapters in separate slices. Gate: the UI displays stored real runs, cancellation works, and CLI/API/MCP share report semantics. GitHub Action may ship earlier once the CLI is stable. Hosted implementation then follows the required gates in section 25.

**Phase 8 — Public release hardening**
Packaging, cross-platform smoke checks, security regression tests, performance budgets, independent benchmarks, docs, demo recording, contributor onboarding, and release automation. Gate: a new user can install the packed artifact, scan a repository, run the documented demo, inspect a failure, verify a patch, export a test, and replay evidence.

An initial local public preview can ship after Phase 5 with explicit capability limits. The hosted product additionally requires section 25 gates H0–H5. Full parity and later phases remain visible roadmap work until verified. Do not call a preview feature complete by hiding missing checks.

### 23. Definition of done and first task

A milestone is done only when it has working code, meaningful validation, usable instructions, versioned contracts where relevant, and honest limitations. No TODO implementation, fake provider, mocked execution result, or static dashboard constitutes engine functionality.

Begin now with Phase 0. Inspect the existing repository, report what exists, produce the initial design documents and capability plan, and choose the smallest Phase 1 vertical slice. If no repository exists, initialize a local project without publishing it. Do not write the entire platform at once. End the milestone with changed files, commands run and their outcomes, the main execution flow, learning notes, and the next concrete step.

### 24. Hosted architecture, durability, and security

This section is a required part of the implementation, not a list of optional future ideas. Build it incrementally using the shared engine established in the earlier phases. Sections describing local storage/server behavior apply only to local mode. Hosted mode uses the following boundaries.

#### 24.1 Control plane and execution plane

Deploy the dashboard as static assets through a CDN. Place stateless NestJS/Fastify API replicas behind an ingress/load balancer. Keep health, readiness, graceful shutdown, proxy trust, and request-size/time limits explicit. Do not execute scans, resolve untrusted project configs, install dependencies, or perform CPU-heavy AST analysis in API request handlers.

The API authorizes requests, validates inputs, stores durable intent, and returns `202 Accepted` with a run ID/status URL. Hosted CLI mode submits to this API; local CLI mode invokes the engine directly. Use a documented authentication flow for the hosted CLI, not credentials in command-line arguments.

Trusted orchestration workers drive Temporal activities. They request disposable sandbox jobs through a restricted job launcher. Put static analysis, browser checks, mutation tests, and AI calls into independently limited queues/pools. A run's execution steps may finish out of order; record actual dependencies and states.

Sandbox code must have no access to the application database, workflow service, cache, orchestration identity, cloud metadata endpoint, Kubernetes API, or control-plane network. Disable service-account token automount. Give the trusted launcher narrowly scoped rights to create/read/delete allowed jobs in execution namespaces; sandbox jobs get no such rights. Do not mount the host Docker socket.

Use dedicated execution nodes and a supported gVisor RuntimeClass for the initial hosted isolation target. Enforce non-root identities, dropped capabilities, restricted volumes, resource/ephemeral-storage quotas, network denial, execution deadlines, and cleanup. Validate the runtime against browser and database workloads. If a required workload is incompatible, document and evaluate a separate isolation backend; never silently weaken isolation. Kubernetes namespaces alone are not a security boundary.

Define an authenticated result channel: a supervisor collects outputs, validates report schemas and artifact digests, and persists them through scoped upload grants. Untrusted stdout cannot instruct the control plane. An authorized tenant can intentionally falsify its own test code, so evidence establishes observed execution under specified inputs, not absolute truth about its repository.

#### 24.2 Durable submission and workflow semantics

Implement a transactional outbox in PostgreSQL: a transaction creates the run and outbox intent; a dispatcher starts a Temporal workflow with a stable workflow ID derived from that run. Reconcile ambiguous acknowledgements and duplicate deliveries using workflow identity and a unique database constraint. Never assume an atomic transaction spans PostgreSQL and Temporal.

Temporal owns orchestration state; PostgreSQL is the queryable application projection, updated idempotently using versioned transitions/events. Document which system is authoritative for each field. Rebuild/reconcile projections after interruption. A cached status is never authoritative.

Activities perform side effects and may be retried. Make job launch, result persistence, artifact finalization, and GitHub status publication idempotent. Track each attempt separately. Use bounded retries with backoff for transient infrastructure failures; an observed failed test is a result, not an infrastructure retry trigger. Do not claim exactly-once execution or billing.

Apply activity timeouts, heartbeats where applicable, workflow/run deadlines, and cancellation propagation. Cancellation must stop queued work and request sandbox termination; report pending cleanup until the supervisor confirms it. A periodic reconciler removes orphan jobs and detects lost workers. Cap workflow history size; store large outputs in object storage and use references, with history rollover/child workflows where justified. Workflow versioning must support upgrades without invalidating in-flight runs.

Use a minimal compatible single-instance Temporal service for development. Production documentation must cover a managed or properly operated self-hosted Temporal service; a development server is not a highly available deployment.

#### 24.3 Multi-tenancy and authorization

Model organizations, users, memberships, repositories, installations, runs, requirements, findings, proposals, and artifacts. Every tenant-owned record has `organization_id`; enforce tenant consistency in foreign keys and uniqueness constraints. Derive tenant context from authenticated membership, never merely from a request body's organization ID.

Define roles with explicit permissions: owner/admin, maintainer, reviewer, and viewer. Separate viewing source/evidence, starting expensive execution, accepting requirements, applying patches, and managing integrations. Test horizontal and vertical privilege escalation across every route and artifact operation.

Use application authorization plus PostgreSQL row-level security for tenant data as defense in depth. Use a non-owner runtime role without RLS bypass. Set tenant context transaction-locally; test that it does not leak across pooled connections. Keep migrations and administrative access on separate credentials. Audit background-worker and maintenance access; do not simply bypass tenant policy for all workers.

Use a maintained OIDC provider; validate issuer, audience, signature, expiry, and redirect URIs. Secure cookie sessions or short-lived tokens must have documented CSRF/CORS handling. Prefer a same-origin API route for the hosted dashboard. Native EventSource authentication limitations must be accounted for; never put long-lived bearer credentials in URLs. Bind API keys to an organization and scope, hash secrets at rest where applicable, and support revocation.

GitHub access uses a properly registered App in the hosted integration phase. Validate webhook signatures over raw bytes, deduplicate delivery IDs, and acknowledge quickly before asynchronous processing. Request minimal installation permissions and use short-lived scoped tokens. Do not expose tokens to repository code; a trusted fetcher prepares snapshots without leaving credentials in Git config or files.

Keep an audit trail for membership changes, policy edits, credential actions, requirement acceptance, execution requests, patch application, and exports. Source code, patches, and raw secrets do not belong in audit logs.

#### 24.4 Data, pooling, and artifacts

Use PostgreSQL as the system of record for hosted application metadata, with Drizzle migrations and explicit transactions. SQLite and PostgreSQL share repository interfaces and contract tests, not an assumption of identical SQL, locking, or migration behavior. Maintain separate migration suites. Use keyset pagination and indexes based on measured queries, including tenant/status/time run listings and tenant/repository/fingerprint finding lookups.

Use PgBouncer with bounded application pools. Set a total connection budget across API replicas, orchestration workers, dispatchers, and administrative tasks, leaving operational headroom. Verify driver/prepared-statement behavior with the chosen pool mode. Migrations and session-dependent administrative operations may need direct connections. Measure query plans before adding read replicas; replicas must not serve stale authorization or newly created run state without an explicit consistency policy.

Use expand/contract schema changes, one controlled migration runner, statement/lock timeouts, and rollback/roll-forward procedures. Provide encrypted backups, point-in-time recovery where available, and restore drills. Document target recovery objectives and measured restore time.

Use private S3-compatible buckets with encrypted transport/storage, short-lived tenant-scoped upload/download grants, checksums, size/type limits, multipart-upload cleanup, and retention policies. Store a pending artifact record before upload and finalize after validation; garbage-collect abandoned objects and records. Never assume the database and object store commit atomically.

Namespace artifact and dependency-cache access by tenant/trust boundary. Content-addressed hashes must not permit cross-tenant existence probing or private-source downloads. Treat dependency caches as untrusted and verify package integrity. Avoid cross-tenant artifact deduplication initially. Cache keys include relevant inputs; changing accepted requirements invalidates dependent verification results.

Valkey is for disposable caches and distributed limits. Cache failures must not erase durable runs. Define safe fallback behavior: costly execution admission fails closed or uses a durable quota mechanism when the cache is unavailable. Use database-backed reservations/leases for critical concurrency and budget allocation rather than an eviction-prone counter alone.

#### 24.5 Load management and observability

Distinguish HTTP throughput from execution throughput. Enforce per-tenant and global active-run limits, repo/snapshot limits, browser/mutation concurrency limits, CPU/memory/wall-time quotas, artifact quotas, and provider budgets. Apply fair scheduling so a large tenant cannot starve others. Return explicit `429`/capacity responses where appropriate, with retry guidance. Bound queued work rather than accepting unlimited backlog.

Scale API replicas using request/latency/resource measurements. Scale worker pools using eligible queue backlog, oldest queue age, available sandbox slots, workload class, and infrastructure/provider limits. Adding workers beyond database or sandbox capacity must not increase overload. Limit work per worker and shut down gracefully without losing claims or orphaning jobs.

Use OpenTelemetry correlation across request ID, run ID, workflow/activity, sandbox attempt, and artifact references. Keep tenant/run IDs out of high-cardinality metric labels; use controlled logs/traces for per-run drilldown. Measure submission latency/errors, queue age, workflow retries, completed/failed/inconclusive checks, job startup time, CPU/memory, artifact volume, DB pool waits, cache health, and estimated cost per run. Do not log source content or tokens by default.

SSE progress must survive API replica changes: maintain an ordered, authorized run-event feed with retention and Last-Event-ID replay, plus polling fallback. Do not rely on process memory or sticky sessions. Bound per-client buffers; coalesce repetitive log events, support slow readers, and keep terminal states queryable in the database.

### 25. Required hosted implementation gates

Develop these alongside the applicable engine phases. First establish a working scan/verification vertical slice, then expose it through the hosted stack; avoid spending the entire project on infrastructure before a real finding exists.

**H0 — Architecture and development deployment.** Deliver ADRs for NestJS/Fastify, PostgreSQL, Temporal, Valkey, object storage, tenant boundaries, and isolation. Provide Compose profiles for application infrastructure and a separate execution profile. CI and local development must clearly distinguish trusted fixture execution from production sandbox guarantees. Gate: a contributor can start the documented services and run a real scan through the shared engine.

**H1 — Tenant-aware hosted API.** Implement authentication, organizations/memberships, permissions, PostgreSQL storage, RLS, audit records, API contracts, pagination, and artifact access. Gate: cross-tenant requests and downloads are denied in automated integration tests; pooled tenant context does not leak; authorized read/write flows work.

**H2 — Durable asynchronous verification.** Add the transactional outbox, Temporal workflows/activities, separate workers, cancellation, resumable event feed, and idempotent result storage. Gate: submission returns a run ID without executing tests in the API; killing/restarting the API, dispatcher, and workers does not lose accepted work or create duplicate logical results. Inject duplicate deliveries and ambiguous start acknowledgements.

**H3 — Hosted sandbox isolation and artifacts.** Implement restricted job launcher, gVisor-backed execution target, separate node pool policy, network controls, short-lived artifact grants, quotas, cleanup, and credential isolation. Gate: attempts to reach platform data stores/metadata endpoints, access host paths, obtain service-account credentials, exceed quotas, or escape artifact paths are denied under the documented deployment. Independent security review is a release gate for public untrusted-code hosting; record unresolved risks and do not certify safety solely from passing fixtures.

**H4 — Dashboard and GitHub App.** Connect the existing workbench to real hosted runs, implement organization context, authorized SSE/polling, and least-privilege GitHub App/webhook processing. Gate: real PR events create one logical run, reports are scoped correctly, reconnect works across API replicas, and no credential reaches the target sandbox.

**H5 — Capacity, recovery, and operations.** Deliver Terraform modules, deployment manifests/Helm, health probes, autoscaling policies, monitoring, alerts, backup/restore runbooks, artifact retention, rolling upgrade procedures, and a capacity report. Gate: load and recovery checks below are run in a named environment with costs and bottlenecks recorded. A local Compose demonstration does not satisfy production readiness.

### 26. Performance and recovery acceptance plan

Use k6 for HTTP/API/event-stream load and a separate bounded execution-load harness. Define illustrative starting SLOs, then validate and adjust with a written rationale: for example p95 run-submission latency under 500 ms and application error rate under 1% at the stated offered load, excluding user-policy rejections. These are test targets, not promised capacity. Give read endpoints, streaming reconnect, and heavy verification their own metrics and time budgets.

Create workload profiles for warm reads, authenticated submissions, dashboard polling/SSE, webhook bursts, artifact downloads, short scans, browsers, and expensive mutation runs. Record repository sizes, test counts, job resource requests, cache state, provider calls, offered arrival rates, hardware, replicas, regional latency, and test duration. Use a closed-loop and/or arrival-rate model appropriate to the question; explain the difference.

Measure the saturation point using bounded ramp, burst, and soak tests. Report p50/p95/p99 latency, errors, queue wait, completion throughput, resource use, cost, and degraded behavior. Measure no-cache runs and tenant contention. Verify that large artifact downloads use object storage rather than monopolizing API replicas.

Inject worker death, sandbox timeout, duplicate webhooks, dispatcher failure after workflow start, object-store failure, cache outage, database interruption, and provider throttling. Confirm that statuses remain honest, retries are bounded, accepted work is reconciled, and resources eventually clean up. Test rolling worker version changes with in-flight workflows. Exercise recovery from backup in a separate environment and verify representative artifact references.

Add a traffic/cost planning worksheet: expected active organizations, submissions per minute, workload-class mix, average job runtime, CPU/memory per job, retention, and utilization target. Estimate active job concurrency from arrival rate multiplied by mean runtime, then account for bursts, headroom, and resource shape. Label estimates separately from measurements. Never claim a million users based on API benchmarks alone.

### 27. Updated first task and delivery order

Phase 0 must now include H0's hosted design, a proposed minimal development deployment, a tenant data model, workflow/outbox sequence, and a trust-boundary diagram. Explain every new service's operational cost. Begin with a usable engine slice, then one authenticated hosted scan through API → durable workflow → isolated execution → evidence → report. Expand features only after that path is real.

Preserve the original learning workflow. Explain Nest modules/providers, transaction boundaries, RLS and pool interactions, Temporal determinism/retries, object-store consistency, sandbox permissions, and scaling signals as each is introduced. Do not generate a stack diagram and call the backend implemented. Do not deploy paid cloud infrastructure or publish credentials as an automatic consequence of generating code; prepare reviewable infrastructure and a cost estimate first.

### 28. Required TypeScript–Rust implementation

**Ownership.** TypeScript owns domain contracts, rule orchestration, TypeScript semantic analysis, acceptance requirements, reproductions, test adapters, mutation integration, patch verification, providers, transports, and reports. Rust owns a small passive repository scanner: file enumeration, ignore evaluation, metadata, content digests, binary detection, and selected text-pattern checks. The scanner must not execute project configuration, install dependencies, invoke build tools, or run repository programs.

Do not move TypeScript type checking into Rust. A parser does not reproduce the TypeScript compiler's type system or project resolution. Do not independently implement the same rule in both languages. The registry identifies its executor (`native-text`, `typescript-ast`, `external-analyzer`, or `behavioral`) with one canonical rule ID/version.

**Rust structure.** Implement `crates/scanner-core` as a library and `crates/scanner-cli` as a thin executable. Evaluate `ignore` for Git-compatible discovery, `regex` for bounded text patterns, `serde`/`serde_json` for serialization, `clap` for arguments, and `sha2` for content digests. Verify maintenance, licenses, MSRV, compatibility, and APIs at setup. Bound concurrency; add Rayon only when it simplifies the actual workload. Avoid project-owned unsafe code unless a reviewed requirement justifies it. Commit Cargo.lock and a pinned toolchain; explain borrowing, ownership, errors, iterators, and concurrency as introduced.

**Protocol.** Implement `packages/scanner-client` as the TS boundary. Start with a subprocess, not native bindings or a daemon. Resolve the installed binary explicitly; invoke through `spawn` using argument arrays without a shell. Exchange versioned newline-delimited JSON over stdin/stdout, with diagnostic text only on stderr.

Specify request IDs, protocol major/minor versions, scanner version, capabilities, effective options, progress, warnings, file records, findings, summary, and terminal failure. Validate incoming records with Zod and Rust deserialization plus size limits. Maintain shared schema fixtures and cross-language tests. Reject incompatible major versions. EOF without a terminal message is incomplete; a scanner crash is not a clean scan. Add backpressure and cap message size, output, files, bytes, threads, elapsed time, and stderr retention. Cover spawn failure, unsupported platform, malformed JSON, panic, partial output, cancellation, and timeout.

Do not stream complete source by default. Return necessary locations, digests, warnings, and bounded snippets under policy. Use graceful cancellation followed by forced termination after a deadline where supported. Native crashes must not terminate the API. Document illustrative protocol examples separately from real execution captures.

**Filesystem correctness.** Define precedence across `.gitignore`, explicit includes/excludes, generated files, hidden paths, and symlinks. Do not follow links outside the approved root by default. Handle Windows paths, case sensitivity, unreadable files, and non-UTF-8 filenames explicitly. Never silently merge distinct paths through lossy conversion.

Hash actual bytes with a documented digest algorithm/schema version. Bound per-file and total memory. Discovery/hashing does not freeze a changing worktree: resnapshot or flag inconsistent files. Behavioral verification uses an immutable captured snapshot. Define canonical source offsets and convert Rust byte positions correctly to editor/TypeScript UTF-16 positions; test emoji, non-ASCII text, CRLF, and line boundaries. Unsupported encodings/binary content produce explicit skip/unsupported outcomes. Use AST rules for syntax-sensitive checks rather than claiming text matching proves a vulnerability.

Produce deterministic normalized findings for fixed inputs, preserving actual measured durations/timestamps separately. Do not assume parallel arrival order is stable. File counts alone must not become a misleading quality score.

**Distribution.** Publish prebuilt scanner artifacts for explicitly tested targets, initially Linux x64/arm64, macOS x64/arm64, and Windows x64 where CI permits. Distinguish glibc/musl. Cross-compilation is not evidence that a target works. Use npm platform packages/optional dependencies or a documented integrity-checked binary distribution. Avoid arbitrary install-time downloads/scripts. Normal users must not need Cargo or a Rust compiler.

Resolve binaries from the installed package rather than arbitrary PATH entries. Pin scanner compatibility and release artifacts. Test packed npm installation outside the monorepo for each supported target. If the scanner is missing, fail with an actionable explanation or use an explicitly implemented compatible fallback; never silently omit native checks. Use `cargo fmt --check`, Clippy, Cargo tests, dependency/license checks, protocol tests, and installation smoke checks.

Benchmark cold/warm scans with bytes/files, runtime, memory, concurrency, hardware, platform, and versions. Claim a speedup only against an actual comparable baseline. NAPI-RS is an optional future optimization when process/serialization overhead is measured, not a first-release dependency. Do not add a Go service or duplicate API in Rust.

### 29. Current release sequence: get real users before fleet complexity

This ordering supersedes any earlier requirement to complete the full hosted deployment before user feedback. Preserve earlier engine and hosted requirements as tracked work; only claim completed gates.

**R0 — Installable foundation.** Set up pnpm/Turborepo and Cargo, contracts, Rust scanner, scanner-client, minimal TS engine, CLI, and JSON/Markdown reports. Gate: a developer outside the monorepo can install the packed release and scan clean/faulty repositories without an account or Rust compiler. Explain the complete config → Rust → TS normalization → report file flow.

**R1 — Local verification preview.** Add immutable snapshots/diffs, TS impact analysis, Vitest execution, one accepted behavior pack, reproduction, regression export, a labeled deterministic patch, and before/after checks. Execution is explicitly enabled on the user's machine or CI. Gate: the real coupon demo works, exported tests run independently, and a supported workflow works on a repository beyond the demo. Record setup errors and unsupported configurations honestly. Include the original failing check unchanged in patch verification.

**R2 — Hosted dashboard beta.** Add NestJS/Fastify, PostgreSQL/Drizzle, private object storage, established OIDC identity integration, organizations/permissions, explicit report upload, and real UI views. The CLI/user CI executes checks; the server validates, authorizes, stores, and displays evidence. Source upload is a separate explicit setting. Do not require Temporal merely to ingest a small report; use it when durable asynchronous server workflows are implemented.

Treat uploads as user-controlled evidence. Validate schema, tenant/repository/commit identity, size, content types, and artifact paths. Record execution origin (`local`, `user-ci`, `managed`), uploader, versions, and timestamps. An authenticated or checksummed upload is not independent attestation that its claimed tests ran truthfully. Never label local evidence as managed execution. Escape HTML, source snippets, and logs. Prevent cross-tenant access and test connection-pool tenant context isolation.

**R3 — GitHub workflow and community release.** Publish a version-pinned Action that uses the same CLI, creates SARIF/Markdown output, retains reproduction artifacts, and respects explicit upload settings. Document fork permissions and trust boundaries. Supply contribution tutorials, support matrix, parity status, real demo recording, and troubleshooting. Gate: external testers can finish install → check → evidence → repair without maintainer intervention. Collect actual feedback; do not invent adoption figures.

**R4 — Managed execution.** Implement Temporal, durable outbox, separate trusted orchestration workers, disposable hosted sandboxes, quotas, and section 25's H0–H5 gates. Kubernetes/gVisor belong to this release path, subject to tested compatibility and threat modeling. R2 servers do not become managed runners by exposing a shell endpoint. Pass hosted security/recovery gates before accepting arbitrary public code execution.

**R5 — Scale measured workloads.** Deploy Valkey caches/distributed limits, PgBouncer, larger pools, autoscaling, and tuning when observations justify them. Basic bounded pools, authorization, quotas, backups, monitoring, and admission limits are required earlier; defer only additional infrastructure. Capacity claims require the load tests in section 26. Keep `docs/releases.md` mapping engine phases and H gates to R0–R5.

The initial hosted deployment is a static dashboard/CDN, an API service, managed PostgreSQL, private object storage, and identity integration. Add a trusted worker for actual asynchronous tasks. Provide environment templates with placeholders, secret handling, health checks, backups, rollback instructions, and a cost worksheet. Verify current provider terms/regions rather than inventing free-tier guarantees. Avoid automatic paid infrastructure deployment.

### 30. Real-user testing and updated first instruction

Prepare a voluntary beta cohort with different supported repository shapes: a small TypeScript API, a workspace/monorepo, a frontend application, and projects using supported runners. No private-source upload by default. Do not publish findings, repository names, or testimonials without permission. Separate user diagnostic consent from basic product use.

Provide an onboarding checklist, doctor command, issue template, and opt-in diagnostics that users can preview and redact. Track installation success, time to first useful finding, false positives, replay success, patch-verification clarity, runtime, and repeat use, with clear definitions and denominators. Collect qualitative confusion and incompatibilities. Stars and detector counts do not establish reliability.

Before beta releases, test packed installation, native binary selection, upgrades, report-schema compatibility, failed migrations, interrupted uploads, wrong runner versions, cancellation, and secret redaction. Run PatchProof against its own codebase with exclusions disclosed. Keep a clean fixture corpus to detect noise and faulty fixtures to detect missed findings. Review each report's passed/failed/inconclusive scope.

Maintain the teaching workflow throughout. Explain TS/Rust protocol boundaries, Rust ownership/errors, Nest modules, DB transactions, RLS/pooling, workflow idempotency, artifact consistency, isolation, and scaling signals when introduced. Do not dump all code at once or require that I learn every infrastructure component before running the first scanner.

Begin Phase 0 now with R0–R5 as the current delivery order. Inspect the repository and applicable instructions, inventory upstream capabilities/license, write the key ADRs, and implement the smallest R0 slice when the milestone plan is concrete. End with changed files, actual commands/results, execution flow, learning notes, limitations, and the next task. Do not publish/deploy externally without the appropriate authorization.

## END OF MASTER BUILD PROMPT

## Continuation instruction

Read `PROJECT_SPEC.md`, `docs/progress.md`, relevant ADRs, and the actual code. Determine the last completed gate from evidence rather than assuming prior claims are accurate. Continue the next unfinished milestone in small runnable slices. Preserve existing changes, update learning notes, run appropriate checks, and report implemented behavior separately from planned behavior. Explain the important code and file flow as you work.

## Official references for implementation-time checks

These sources informed the stack choice. Recheck version-specific APIs during implementation; this document is not an exhaustive dependency compatibility audit.

- Node.js releases/downloads: https://nodejs.org/en/download
- pnpm workspaces: https://pnpm.io/workspaces
- Turborepo: https://turborepo.com/docs
- TypeScript: https://www.typescriptlang.org/docs/
- ts-morph: https://ts-morph.com/
- Fastify: https://fastify.dev/docs/latest/
- React: https://react.dev/
- Vite: https://vite.dev/guide/
- Vitest: https://vitest.dev/guide/
- StrykerJS incremental mode: https://stryker-mutator.io/docs/stryker-js/incremental/
- StrykerJS plugins: https://stryker-mutator.io/docs/stryker-js/plugins/
- fast-check: https://fast-check.dev/docs/introduction/
- fast-check concurrency: https://fast-check.dev/docs/advanced/race-conditions/
- Playwright: https://playwright.dev/docs/intro
- Docker security: https://docs.docker.com/engine/security/
- MCP SDKs: https://modelcontextprotocol.io/docs/sdk
- Inspiration repository: https://github.com/MrSpideyNihal/FixMySlop
- Existing project with a documented patchproof CLI: https://github.com/MarinJursic/PatchVerification
- NestJS with Fastify: https://docs.nestjs.com/techniques/performance
- PostgreSQL concurrency: https://www.postgresql.org/docs/current/mvcc-intro.html
- PostgreSQL row security: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PgBouncer configuration: https://www.pgbouncer.org/config.html
- Temporal workers: https://docs.temporal.io/workers
- Kubernetes Jobs: https://kubernetes.io/docs/concepts/workloads/controllers/job/
- gVisor: https://gvisor.dev/docs/
- Valkey: https://valkey.io/docs/
- OpenTelemetry JavaScript: https://opentelemetry.io/docs/languages/js/
- k6: https://grafana.com/docs/k6/latest/
- Rust documentation: https://www.rust-lang.org/learn
- Cargo: https://doc.rust-lang.org/cargo/
- Rust subprocesses: https://doc.rust-lang.org/std/process/
- ignore crate: https://docs.rs/ignore/
- serde: https://serde.rs/
- NAPI-RS, optional future bindings: https://napi.rs/
