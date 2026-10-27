# Threat model (implemented scope)

Scope: the local CLI (`scan`, `diff`, `impact`, `run`, `compare`, `requirements`,
`doctor`). There
is no server, no database, no network access, and no hosted execution. `scan`,
`diff`, `impact`, and `compare` execute nothing; `run` executes repository test
files on the user's machine inside a disposable copy, and that path is modelled
below. `compare` reads two stored `run` reports and is bounded by the same rules
that produced them.

## Assets

| Asset | Why it matters |
| --- | --- |
| Source content of the scanned repository | May be private; must not leak into logs, reports, or telemetry |
| Credential material inside the repository | A scanner that echoes secrets creates a new leak |
| The user's filesystem | Must not be modified, escaped, or walked without bounds |
| The user's machine resources | A scan must not exhaust CPU, memory, or disk |
| Report integrity | A report that claims a clean scan it did not perform is worse than no report |

## Trust boundaries

1. **Repository content → scanner.** Untrusted. Filenames, encodings, sizes, and
   file contents are all hostile input.
2. **Scanner stdout → TypeScript client.** Untrusted even though we wrote the
   scanner: a corrupted build, a wrong binary, or a future bug must not become a
   silent "no findings".
3. **CLI arguments → engine.** Untrusted user input, validated at the boundary.
4. **Report → consumer.** Must not carry unescaped active content (HTML/Markdown
   injection into a later renderer).
5. **Requirement document → evaluation.** Committed and reviewable, but still
   input: an acceptance is only as good as the digest it carries, and a check is
   a name, not a promise that the test asserts the statement.

## Threats and current status

| # | Threat | Current control | Status |
| --- | --- | --- | --- |
| T1 | Path traversal / escape outside the scan root | Paths come from a walk rooted at a canonicalized directory; symlinks are not followed by default; relative paths are rebuilt from components | implemented |
| T2 | Symlink pointing outside the root | `followSymlinks: false` by default; enabling it is explicit | implemented |
| T3 | Reading an enormous file or tree (resource exhaustion) | Per-file, total-byte, file-count, findings-per-file limits; walker max file size | implemented |
| T4 | Huge or hostile scanner record floods the client | 1 MiB per-record cap, 8 KiB retained stderr, request timeout, process kill on violation | implemented |
| T5 | Scanner crash interpreted as a clean scan | A stream without `done`, a non-zero exit, or an exit/`done` mismatch is an error | implemented |
| T6 | Unknown rule ID silently scanning nothing | Engine rejects rule IDs the scanner does not publish; CLI exits 2 | implemented |
| T7 | Secret echoed into a report or terminal | Redaction before serialization for secret rules; tests assert the raw value never appears in scanner output, JSON report, or Markdown | implemented |
| T8 | Report claims coverage it does not have | `filesScanned` vs `filesSkipped`, `truncated`, `limitsHit`, and a mandatory limitations array | implemented |
| T9 | Malformed request crashing the scanner | Request JSON is deserialized with serde; an invalid request emits `error` + `done` and exits 2 | implemented |
| T10 | Shell injection when invoking the scanner | `spawn` with an argument array, no shell, no string interpolation of user input | implemented |
| T11 | Binary hijack from `PATH` | Resolution is explicit path, `CODECITADEL_SCANNER_BIN`, an installed platform package, or a Cargo build found upward from the working directory; `PATH` is never consulted | implemented |
| T12 | Output injection into a future HTML/CSV renderer | Markdown escaping for table cells and dynamic code fences; HTML/CSV renderers do not exist yet | partial |
| T13 | Scan of a worktree that changes mid-read | File digests are recorded per file, but there is no immutable snapshot yet; a changed file can produce a digest that no longer matches the tree | **not implemented** |
| T14 | Unicode/encoding confusion hiding a finding | Binary and non-UTF-8 files are skipped with a reason rather than silently decoded; offsets tested for emoji, non-ASCII, and CRLF | implemented |
| T15 | Repository content used as instructions to an AI provider | No provider is implemented in this milestone | not applicable yet |
| T16 | Installed scanner binary replaced or corrupted after install | `binary.json` records a SHA-256 digest; the client re-hashes the binary on every launch and refuses to run it on a mismatch, a manifest pointing outside its package, or a binary with no manifest | implemented |
| T17 | Malicious or broken platform package shadowing the real one | Package name is derived from `process.platform`/`process.arch`, the binary must live inside that package, and a failed check is fatal rather than a fallback | implemented |
| T18 | Executed test code rewrites the analyzed checkout | `run` executes in a disposable copy in the OS temp directory by default; running in the checkout requires `--isolation none`, and the record says which mode was used | implemented (directory copy, not a sandbox) |
| T19 | Executed test code modifies installed packages | `node_modules` is linked back to the checkout so imports resolve without an install. A test can therefore still mutate dependencies; the report lists the shared paths and this limitation | partial — no read-only mount |
| T20 | Test code reaches host credentials or inherited configuration | The child process gets an allow-listed environment (`PATH`, `SystemRoot`, temp/home variables, locale) plus `NO_COLOR`; `NODE_OPTIONS`, tokens, and CI secrets are not inherited | implemented |
| T21 | Runner hangs or floods output | Deadline (default 120 s) with SIGTERM then SIGKILL after 5 s, cancellation through an `AbortSignal`, and a 64 KiB shared stdout/stderr budget; truncation is reported | implemented |
| T22 | Test names or failure messages leak secrets into the report | Messages are stripped of ANSI, reduced to the first non-empty line, and bounded to 400 characters. Test output itself is not scanned for secrets | partial |
| T23 | A tampered Vitest install produces fabricated results | The runner is resolved from the project (or `--runner`) and its version is recorded, but the runner is not integrity-verified; results are the runner's claims about itself | not implemented |
| T24 | A passing selected run is read as proof the change is correct | Reports carry mandatory limitations saying a pass covers only the selected tests in this environment; `skipped` and `errored` are never `passed` | implemented |
| T25 | A comparison taken as evidence when the two runs are not comparable experiments | `comparable: false` is set with one reason per mismatch (root, platform, Node version, runner version, isolation mode, selected test files, or a file whose change classification differs), the reasons are printed to stderr, and the exit code is 2 rather than 0. The pairing is still rendered, and its `limitations` say it must not be used as verification evidence | implemented |
| T26 | An edited test keeps its fingerprint and a rewritten assertion passes as unchanged | The fingerprint covers file path and test name, not the body: a test whose assertions changed keeps its id. `identitySuspect` marks tests from files whose change classification differs between the two runs, and every comparison carries a limitation stating the fingerprint does not capture the test body | partial — nothing stores a body digest yet |
| T27 | A comparison verdict read as proof the patch is correct | Exit codes separate the cases: 0 (comparable, nothing failing after), 1 (a test fails after the change), 2 (not comparable, or evidence lost through inconclusive or newly skipped results). `gone` is reported but never counted as a failure, and limitations state the verdict is only as good as the two stored reports | implemented |
| T28 | A requirement approved by the tool itself, or inferred from a passing test | No path sets `state: "accepted"` except `requirements accept`; the schema rejects an accepted requirement with no acceptance record; evaluation returns `not_accepted` for a proposed or rejected requirement even when every check passed | implemented |
| T29 | An approval silently transferred to requirement text that was edited afterwards | The acceptance carries a SHA-256 digest over `{id, statement, checks}`; every read recomputes it. A mismatch is `stale`: `requirements list` exits 2 and `requirements check` returns `not_accepted` | implemented |
| T30 | A weakened or renamed test still counted as satisfying its requirement | Checks pair by `file + full name` fingerprint, so a rename becomes `not_run` and is visible. A same-name body edit keeps the fingerprint and is not detected — the digest covers the requirement, not the test | partial — no test-body digest |
| T31 | A requirement document used to execute code or reach outside the analyzed tree | The document is data: strict schema, no paths resolved or opened, no execution; `check` reads one stored report and never a repository file | implemented |
| T32 | A stored run report from a different tree presented as evidence for a requirement | Nothing compares the report's root or snapshot identity with the tree the document lives in; the evaluation's mandatory limitations state that. Root/snapshot binding is required before reports move between trees for patch verification | not implemented |
| T33 | A patch that weakens its own evidence (deletes tests, adds `.skip`, removes assertions, edits requirements or runner config) is announced by a green post-patch suite | `inspectPatch` classifies every touched file and scans added/removed lines for skips, focus, suppressions, and net assertion loss; any `weakening` signal forces `not_verified` before outcome comparison is even consulted — no override, none planned | implemented (lexical; semantic edits inside a test body are invisible) |
| T34 | A patch verified in a copy is read as proof the change is correct, or as proof it was applied | `patch verify` writes only inside a disposable copy and deletes it; reports carry the checkout-mutation and correctness limitations; exit 2 covers not-applied and inconclusive, so a refusal cannot look like a pass | implemented |
| T35 | A broken setup (bad import, collection error, timeout, skipped test, renamed test) is reported as a reproduced bug | `decideReproductionVerdict` only calls a **failed named result** `reproduced`; a run status of `errored`/`timed_out`/`cancelled`/`unsupported`, or a fingerprint the reporter never reported, is `inconclusive` with the reason preserved, and exit code 2 | implemented |
| T36 | A reproduction counted as evidence for a requirement nobody accepted, or for text edited after approval | The requirement gate runs before execution: `state` must be `accepted` and the acceptance digest `current`, otherwise the verdict is `not_accepted`, `record` is `null`, and no code runs | implemented |
| T37 | An exported regression test silently differs from the run it claims to prove, or overwrites project files | The report carries the check source, its SHA-256 digest, and its byte count; export recomputes both and refuses a mismatch. A destination outside `--out`, inside the analyzed root without `--in-root`, or an existing file without `--force` is refused | implemented |
| T38 | An exported test is assumed portable, or assumed safe because it is a test | Portability is the operator's code: the export copies bytes and warns when it sees a CodeCitadel import. The manifest states the test needs the project's own dependencies and runner, and that the recorded verdict belongs to the original run, not to later executions | implemented (warning + documented limits, not an enforced guarantee) |

## Deliberate non-goals here

- Running untrusted code with container-grade isolation. `run` executes test
  files in a disposable directory with no CPU, memory, network, or syscall
  limits; the local runner must never be exposed as a service, and hosted
  arbitrary execution waits for the R4 gates.
- Running builds, package scripts, or dependency installs.
- Verifying that a patch fixes a bug against a reproduction. `reproduce run`
  proves a declared check fails and `reproduce export` ships it, but nothing yet
  re-runs that check automatically against a candidate patch; `patch verify`
  today can only show that a patch does not contradict stored test evidence.
- Generating reproductions, minimizing payloads, or repeating a flaky check to
  measure a rate. One run is one observation and the report says so.
- Detecting secrets that are transformed, split across lines, or encrypted by
  pattern matching alone.

## Residual risk

Text rules can be wrong in both directions: a pattern can match harmless code
(false positive) or miss a real defect expressed differently (false negative).
Every finding is `suspected`. Treat the report as a starting point for review,
not as a verification result.

## Reporting security issues

There is no published security contact yet, and the project has not been
released. Do not file public issues containing real credentials or private code;
this policy will be replaced before the first public release.
