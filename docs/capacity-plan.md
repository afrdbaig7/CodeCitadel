# CodeCitadel Traffic & Capacity Planning Worksheet (Milestone R5 / Section 26)

## Purpose and Principles

This document provides traffic modeling, queue concurrency formulas, resource sizing, and cost estimations for CodeCitadel's multi-tenant verification control plane.

> [!IMPORTANT]
> **Measurement vs. Estimation Disclosure (Section 26 Rule)**:
> - **Measured numbers** are derived from automated Vitest load test suites (`apps/api/test/load.test.ts`) and k6 runs against isolated PostgreSQL and Valkey engines.
> - **Estimated numbers** are derived from mathematical queuing formulas ($N = \lambda \times W$) and cloud infrastructure pricing worksheets.
> - *Never claim a million users based on API benchmarks alone.*

---

## 1. Mathematical Concurrency Foundation: Little's Law

Active concurrent job count $N$ in steady-state is governed by Little's Law:

$$N = \lambda \times W$$

Where:
- $\lambda$: Average job arrival rate (jobs per second).
- $W$: Mean job duration (seconds in system from pickup to terminal state).
- $N$: Mean active concurrent jobs running across the worker fleet.

To accommodate burst arrival variance and prevent queue backlog buildup, the target fleet capacity $C$ includes a burst multiplier $\beta$ and utilization safety headroom factor $U$:

$$C = \frac{N \times \beta}{U} = \frac{\lambda \times W \times \beta}{U}$$

- **Target Utilization ($U$)**: $0.70$ (70% utilization target allows 30% headroom for sudden PR storms without worker thrashing).
- **Burst Multiplier ($\beta$)**: $2.5 \times$ (accounts for morning developer standup / merge window spikes).

---

## 2. Workload Class Profiles

Different verification contracts exhibit wildly divergent compute and memory footprints:

| Workload Class | Target Operation | Mean Duration ($W$) | CPU Request | RAM Request | Ephemeral Disk |
|:---|:---|:---:|:---:|:---:|:---:|
| **Class A: Static Scan** | Native Rust AST/Slop check | 3.5s | 0.5 vCPU | 256 MiB | 50 MiB |
| **Class B: Impact Analysis** | TypeScript AST reachability | 8.0s | 1.0 vCPU | 512 MiB | 100 MiB |
| **Class C: Behavior Run** | Isolated Vitest execution | 30.0s | 2.0 vCPU | 1.0 GiB | 500 MiB |
| **Class D: Mutation Test** | AST mutation & kill verification | 120.0s | 4.0 vCPU | 2.0 GiB | 1.0 GiB |

### Standard Workload Mix Distribution:
- Class A (Scans): **50%**
- Class B (Impact): **30%**
- Class C (Behavior): **15%**
- Class D (Mutation): **5%**

**Weighted Average Duration ($W_{avg}$)**:
$$W_{avg} = (0.50 \times 3.5) + (0.30 \times 8.0) + (0.15 \times 30.0) + (0.05 \times 120.0) = 1.75 + 2.40 + 4.50 + 6.00 = 14.65 \text{ seconds}$$

---

## 3. Scale Tiers & Fleet Capacity Sizing

### Tier 1: Small Cohort (10 Active Organizations)
- **Submissions**: 10 submissions/minute ($\lambda = 0.167\text{ jobs/s}$)
- **Steady Concurrency ($N$)**: $0.167 \times 14.65 \approx 2.45\text{ jobs}$
- **Provisioned Worker Slots ($C$)**: $\frac{2.45 \times 2.5}{0.70} \approx 9\text{ slots}$
- **Worker Pods**: 3 pods (each running concurrency limit = 3)
- **API Pods**: 2 pods
- **PgBouncer Pool**: 10 backend connections

### Tier 2: Mid-Market Fleet (100 Active Organizations)
- **Submissions**: 120 submissions/minute ($\lambda = 2.0\text{ jobs/s}$)
- **Steady Concurrency ($N$)**: $2.0 \times 14.65 = 29.3\text{ jobs}$
- **Provisioned Worker Slots ($C$)**: $\frac{29.3 \times 2.5}{0.70} \approx 105\text{ slots}$
- **Worker Pods**: 18 pods (each concurrency = 6)
- **API Pods**: 4 pods
- **PgBouncer Pool**: 25 backend connections

### Tier 3: Enterprise Platform (500 Active Organizations)
- **Submissions**: 600 submissions/minute ($\lambda = 10.0\text{ jobs/s}$)
- **Steady Concurrency ($N$)**: $10.0 \times 14.65 = 146.5\text{ jobs}$
- **Provisioned Worker Slots ($C$)**: $\frac{146.5 \times 2.5}{0.70} \approx 523\text{ slots}$
- **Worker Pods**: 52 pods (each concurrency = 10)
- **API Pods**: 12 pods (auto-scaled via HPA up to 30)
- **PgBouncer Pool**: 60 backend connections

---

## 4. Measured Saturation Benchmarks (Section 26 Verification)

The following metrics were empirically measured in automated load tests (`apps/api/test/load.test.ts`):

| Metric | Target SLO | Measured Value | Status |
|:---|:---:|:---:|:---:|
| **Run Submission Latency (p50)** | $< 100\text{ ms}$ | **$21.4\text{ ms}$** | PASS |
| **Run Submission Latency (p95)** | $< 500\text{ ms}$ | **$68.2\text{ ms}$** | PASS |
| **Run Submission Latency (p99)** | $< 1000\text{ ms}$ | **$112.5\text{ ms}$** | PASS |
| **Burst Concurrency Application Errors** | $< 1.0\%$ | **$0.0\%$** | PASS |
| **Cached Run Read Latency (p95)** | $< 80\text{ ms}$ | **$4.2\text{ ms}$** | PASS |
| **Sliding-Window Rate Limit Precision** | Strict rejection on $N+1$ with `Retry-After` | **100% verified** | PASS |

---

## 5. Storage & Retention Budgeting

- **Metadata Rows**: ~2 KB per run record in PostgreSQL.
- **Report JSON**: Compressed payload stored in private S3 / MinIO (mean 35 KB per report).
- **Artifacts (Traces / Logs)**: ~250 KB per run average.
- **Total Storage Per Run**: $\approx 287\text{ KB}$.

### 90-Day Retention Projections:
- **Small (10 Orgs)**: 10/min $\times 60 \times 8 \times 65 \text{ days} \approx 312,000\text{ runs} \implies \approx 89.5\text{ GB}$.
- **Mid-Market (100 Orgs)**: $3,744,000\text{ runs} \implies \approx 1.07\text{ TB}$.
- **Enterprise (500 Orgs)**: $18,720,000\text{ runs} \implies \approx 5.37\text{ TB}$.

---

## 6. Estimated Monthly Cloud Infrastructure Costs (Mid-Market Tier 2)

| Resource | Specification | Quantity | Estimated Cost / Month |
|:---|:---|:---:|:---:|
| **Worker Nodes (EKS/GKE)** | `c6i.xlarge` (4 vCPU, 8 GiB RAM) | 6 nodes | \$613.20 |
| **API Nodes** | `t4g.medium` (2 vCPU, 4 GiB RAM) | 2 nodes | \$48.18 |
| **PostgreSQL (RDS / Cloud SQL)** | `db.r6g.xlarge` Multi-AZ (4 vCPU, 32 GiB) | 1 instance | \$365.00 |
| **PgBouncer Pods** | Co-located or dedicated lightweight container | 2 pods | \$20.00 |
| **Valkey / Redis Cluster** | `cache.m6g.large` (2 vCPU, 6.38 GiB) | 2 nodes (HA) | \$99.28 |
| **S3 / Object Storage** | 2 TB standard tier + egress | 2 TB | \$46.00 |
| **Total Estimated Cloud Cost** | | | **\$1,141.66 / mo** |

*All cost figures are non-binding estimates based on published AWS US-East on-demand rates (October 2026).*
