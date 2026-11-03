# CodeCitadel Release Matrix: Engine Phases & Hosted Gates (R0–R5)

This document formally maps the platform's architectural phases and hosted gates (H0–H5 from Section 25) to delivery milestones R0–R5 (from Section 29 of `PROJECT_SPEC.md`).

---

## Release Mapping Table

| Milestone | Scope & Capabilities | Hosted Gates Mapped | Status | Key Deliverables |
|:---|:---|:---:|:---:|:---|
| **R0: Installable Foundation** | Standalone scanner CLI, Rust native scanner engine, protocol boundary, Zod schemas, zero-account local scanning. | — | **Completed** | `crates/scanner-core`, `crates/scanner-cli`, `packages/scanner-client`, `@codecitadel/cli` |
| **R1: Local Verification Preview** | AST impact analysis, Vitest execution adapter, coupon race concurrency reproduction, patch verification, evidence export/replay. | — | **Completed** | `@codecitadel/core`, `@codecitadel/executor`, coupon-race demo, `codecitadel evidence export` |
| **R2: Hosted Dashboard Beta** | Fastify control-plane API, SQLite/PostgreSQL storage with tenant isolation, private S3 artifact streaming, OIDC auth, static web dashboard. | **H0, H1** | **Completed** | `apps/api`, `packages/storage`, `apps/dashboard`, `/api/v1/reports` |
| **R3: GitHub Workflow & Community Release** | Version-pinned GitHub Action, SARIF log generation, GitHub annotations, artifact uploading, contributor tutorials. | **H2** | **Completed** | `action.yml`, `.github/workflows/ci.yml`, `codecitadel doctor`, SARIF exporter |
| **R4: Managed Execution** | Asynchronous run dispatch, transactional outbox pattern, trusted orchestration worker, disposable sandbox runners, mutation testing. | **H3, H4** | **Completed** | `packages/orchestrator`, `codecitadel dispatch`, `codecitadel mutate`, multi-tenant outbox |
| **R5: Scale Measured Workloads** | Valkey caching & sliding-window rate limits, PgBouncer transaction pooling, Kubernetes worker/API autoscaling (HPA), k6 load acceptance suites. | **H5** | **Completed** | `CachedEvidenceStore`, `ValkeyCacheClient`, `deploy/pgbouncer`, `deploy/k8s`, `load-tests/`, `docs/capacity-plan.md` |

---

## Detailed Gate Alignment

### Gate H0: Hosted Architecture & Security Invariants
- **Addressed in**: R2, R4
- **Invariant**: Tenant boundary isolation; database queries must enforce tenant context; uploads are treated as user-controlled evidence.

### Gate H1: Database Migrations & Multi-Tenant Storage
- **Addressed in**: R2, R5
- **Invariant**: Zero data corruption across concurrent migration runners via `pg_advisory_xact_lock`; connection efficiency via PgBouncer transaction pooling.

### Gate H2: CI/CD Pipeline & Action Integration
- **Addressed in**: R3
- **Invariant**: Secure repository checkouts; token least-privilege scoping; portable SARIF 2.1.0 reporting.

### Gate H3: Durable Asynchronous Orchestration
- **Addressed in**: R4
- **Invariant**: Transactional outbox prevents dual-write failures; workers poll and transition state deterministically without dropped runs.

### Gate H4: Dashboard & Organization Scoping
- **Addressed in**: R2, R4
- **Invariant**: Authenticated sessions view only runs belonging to their authenticated organization; SSE/polling updates live status without credential leakage.

### Gate H5: Capacity, Recovery, and Operations
- **Addressed in**: R5
- **Invariant**: p95 submission latency $< 500\text{ ms}$; application error rate $< 1\%$; automated worker autoscaling based on queue depth; capacity and disaster recovery models documented.
