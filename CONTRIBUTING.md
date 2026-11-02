# Contributing to CodeCitadel

Thank you for your interest in contributing to CodeCitadel! CodeCitadel is an evidence-based code verification platform designed to detect AI slop, analyze change impact, and verify that patches don't cheat tests.

---

## Prerequisites

- **Node.js**: `v24.x LTS`
- **pnpm**: `v11.x` (`pnpm@11.20.0`)
- **Rust**: `1.92.0` (with `cargo`)
- **Git**

---

## Local Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/afrdbaig7/CodeCitadel.git
   cd CodeCitadel
   ```

2. **Install dependencies:**
   ```bash
   pnpm install --frozen-lockfile
   ```

3. **Build the native Rust scanner:**
   ```bash
   cargo build --release --package scanner-cli
   ```

4. **Build the TypeScript workspace:**
   ```bash
   pnpm build
   ```

5. **Run all tests:**
   ```bash
   cargo test --workspace      # Rust scanner suite (32 tests)
   pnpm test                   # TypeScript monorepo suite (345+ tests)
   ```

---

## Monorepo Architecture

```text
apps/
  cli/             # Commander-based CLI tool (codecitadel)
  api/             # Fastify control plane (local + hosted)
  dashboard/       # React 19 + Vite 6 + Tailwind CSS workbench
packages/
  contracts/       # Zod schemas, domain types, and protocols
  scanner-client/  # Subprocess driver for the native Rust scanner
  core/            # Snapshots, diffs, report assembly, weakening detection
  symbol-graph/    # TypeScript AST import and caller reachability graph
  executor/        # Supervised Vitest execution in disposable workspaces
  storage/         # SQLite + PostgreSQL (Drizzle ORM) + S3 artifact storage
crates/
  scanner-core/    # Fast native Rust scanner engine
  scanner-cli/     # Native CLI binary emitting NDJSON stream
```

---

## Contributor Task Guides

### 1. Adding a New Native Rule in Rust

1. Define the rule identifier, severity, category, and explanation in `crates/scanner-core/src/rules.rs`.
2. Implement pattern matching in `ScannerCore::check_content`.
3. Add a test in `crates/scanner-core/tests/` verifying positive matches and clean negative controls.
4. Run `cargo test --workspace` to verify.

### 2. Adding a Verification Behavioral Check

1. Add domain contract definitions in `packages/contracts/src/`.
2. Implement execution and pairing logic in `packages/core/src/`.
3. Wire the corresponding CLI command in `apps/cli/src/commands/`.
4. Add an integration test in `apps/cli/test/`.

---

## Pull Request Guidelines

1. **Conventional Commits:** Use structured commits (`feat: ...`, `fix: ...`, `test: ...`, `docs: ...`, `chore: ...`).
2. **Deterministic Tests:** Never use random seeds or unpredictable delays in test assertions.
3. **Execution Safety:** Repository code must never execute on the host machine without supervised isolation in disposable copies.
4. **Documentation:** Keep documentation synchronized with code changes.
