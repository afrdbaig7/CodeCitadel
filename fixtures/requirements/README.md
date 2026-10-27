# Requirements fixture

`codecitadel.requirements.json` is a declarative requirement document, not a
test project. Its checks name tests (`src/coupon.test.ts`, `src/token.test.ts`)
that belong to no fixture tree here: `codecitadel requirements check` evaluates
them against a **stored run report** produced by `codecitadel run --out`, so the
file is meaningful without executing anything.

Both requirements start as `proposed`. A result cannot satisfy a proposed
requirement: someone has to run

```bash
codecitadel requirements accept coupon.single-redemption --by <name>
```

which writes an acceptance record and a digest over the statement and checks.
Editing the statement or a check afterwards makes the acceptance `stale` —
`requirements list` then exits 2 until the current text is accepted again.

`apps/cli/test/requirements.e2e.test.ts` copies this file into a temporary
directory and exercises the list, accept, and check flows end to end.
