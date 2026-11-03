# PgBouncer Connection Pooling Architecture (Milestone R5)

## Overview

CodeCitadel employs **PgBouncer** in front of PostgreSQL to scale concurrent API request ingestion and worker polling without exhausting database backend processes. PostgreSQL allocates ~10 MB of memory per backend process; spawning thousands of direct connections degrades OS page tables, CPU cache locality, and query throughput.

PgBouncer decouples incoming client connections from physical PostgreSQL worker backends using **transaction pooling**.

---

## 1. Pooling Strategy: Why `pool_mode = transaction`

- **Session Pooling vs. Transaction Pooling**:
  - In *session pooling*, a backend connection is reserved for the entire duration of a client connection. This yields minimal connection savings under high API replica counts.
  - In *transaction pooling*, PgBouncer returns the backend connection to the shared pool as soon as an explicit `COMMIT` or `ROLLBACK` executes (or an autocommit statement finishes).
- **Advisory Lock Compatibility**:
  - Session-level advisory locks (`pg_advisory_lock`) break in transaction pooling because subsequent queries from the same client may land on a different backend connection.
  - **CodeCitadel design**: All migration locks and synchronization primitives in `@codecitadel/storage` use transaction-scoped advisory locks:
    ```sql
    SELECT pg_advisory_xact_lock(hashtext('codecitadel_migrations'));
    ```
    Transaction-scoped locks release automatically upon transaction completion, making them 100% safe and reliable under PgBouncer transaction pooling.

---

## 2. Connection Math & Sizing

| Parameter | Value | Rationale |
|:---|:---|:---|
| `max_client_conn` | 10,000 | Max concurrent incoming connections across all API replicas and worker nodes |
| `default_pool_size` | 25 | Active PostgreSQL connections per database pool (well within PostgreSQL `max_connections = 100`) |
| `min_pool_size` | 5 | Warm idle backend connections maintained to avoid cold-start handshakes |
| `reserve_pool_size` | 10 | Emergency headroom when transaction wait exceeds `reserve_pool_timeout` (3.0s) |
| `max_db_connections`| 100 | Absolute hard ceiling on physical connections opened to the PostgreSQL server |

---

## 3. Deployment Configuration

Connect CodeCitadel API and Worker instances using the PgBouncer endpoint:
```bash
DATABASE_URL="postgres://codecitadel_app:secret@pgbouncer.internal:6432/codecitadel?sslmode=disable"
```
