# Execution fixture

A tiny project used by `apps/cli/test/run.e2e.test.ts`. It exists so the `run`
command can be tested against a real Vitest installation without depending on
this repository's own suite.

- `src/math.ts` + `src/math.test.ts`: a passing test that imports the module.
- `src/writes.ts` + `src/writes.test.ts`: a test that writes a file into its
  working directory, which proves the run happened in a disposable copy.
