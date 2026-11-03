# CodeCitadel k6 Load & Performance Acceptance (Section 26)

This directory contains k6 load testing scenarios for Milestone R5 performance and capacity validation.

## Prerequisites

Install k6:
- **macOS**: `brew install k6`
- **Linux**: `sudo apt install k6` or via official package repository
- **Windows**: `winget install k6` or `choco install k6`

---

## 1. Submission Load Test (`submission-load.js`)

Simulates concurrent pipeline and CLI uploads submitting reports to `/api/v1/reports`.

### Section 26 SLO Criteria:
- **p95 Latency**: `< 500ms`
- **p99 Latency**: `< 1000ms`
- **Error Rate**: `< 1%`

### Execution:
```bash
k6 run \
  -e API_URL="http://localhost:3000" \
  -e AUTH_TOKEN="your_organization_bearer_token" \
  load-tests/submission-load.js
```

---

## 2. Read Cache & Metrics Load Test (`read-load.js`)

Simulates burst dashboard polling and monitoring scrape traffic against `/api/v1/runs/:id` and `/api/v1/metrics`.

### Targets:
- **Run detail p95**: `< 80ms` (demonstrating read-through Valkey caching)
- **Metrics p95**: `< 50ms`
- **Error Rate**: `< 0.5%`

### Execution:
```bash
k6 run \
  -e API_URL="http://localhost:3000" \
  -e AUTH_TOKEN="your_organization_bearer_token" \
  -e RUN_ID="run_your_seed_id" \
  load-tests/read-load.js
```
