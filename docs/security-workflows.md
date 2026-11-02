# Security Model: GitHub Workflows & Fork Permissions

This document specifies the security boundaries, credential policies, and fork permissions for CodeCitadel when integrated into GitHub Actions CI/CD workflows.

---

## 1. Why `pull_request` instead of `pull_request_target`

GitHub Actions offers two triggers for pull requests:

| Event Trigger | Trust Boundary & Secrets Access | Code Executed |
| :--- | :--- | :--- |
| `pull_request` *(Safe, Recommended)* | **Zero Repository Secrets Access**: Runs with read-only token permissions. Cannot access secrets or write to repository branches. | Code from the **PR branch/fork**. |
| `pull_request_target` *(Dangerous for code analysis)* | **Full Repository Secrets Access**: Runs in the context of the base branch and has access to repository secrets. | Can be manipulated to execute untrusted code with base repository privileges. |

> [!CAUTION]
> **CodeCitadel strictly discourages using `pull_request_target` for running repository tests or analysis on untrusted forks.**
> If an attacker submits a PR from a public fork, executing custom test scripts or lifecycle hooks under `pull_request_target` grants that PR access to deployment keys, cloud credentials, or write tokens.

CodeCitadel's official action is designed for `on: pull_request` workflows:
- Scans operate passively without executing repository code.
- Test execution (e.g. `codecitadel run`, `patch verify`) occurs inside disposable copies.
- SARIF uploads require only `security-events: write` permission on the job.

---

## 2. Least-Privilege Permissions Matrix

Every workflow file defining CodeCitadel checks should configure least-privilege permissions at the job level:

```yaml
permissions:
  contents: read             # Required to checkout and scan source code
  security-events: write     # Required to upload SARIF to GitHub Code Scanning
```

If the workflow only generates a Step Summary and does not upload SARIF alerts to the GitHub Security tab, drop `security-events: write`:

```yaml
permissions:
  contents: read             # Read-only checkout
```

---

## 3. Secret Isolation and Redaction

1. **No Secret Leaks in Step Summaries:**
   - CodeCitadel's reporter redacts secret findings (such as AWS keys or API tokens) using high-entropy token masking before formatting markdown.
   - Raw credentials or matched patterns are never written to `$GITHUB_STEP_SUMMARY` or stdout.

2. **Control Plane Tokens (`CODECITADEL_TOKEN`):**
   - For internal repository PRs, tokens can be passed via GitHub Actions Secrets (`${{ secrets.CODECITADEL_TOKEN }}`).
   - For public open-source forks where secrets are unavailable, `upload` defaults to `false`. The action still produces full local SARIF outputs and GitHub Step Summaries without requiring any credentials.

3. **OIDC Federation (Zero Long-Lived Secrets):**
   - In hosted mode, CodeCitadel supports OIDC token exchange via `permissions: id-token: write`. GitHub Actions requests a short-lived OIDC JWT from GitHub's token authority, which CodeCitadel verifies cryptographically via JWKS without any long-lived secret stored in repository settings.
