import type {
  DiffFileChange,
  EvidenceBundleItem,
  FindingItem,
  ImpactChainItem,
  PatchProposalItem,
  RequirementItem,
  ReproductionItem,
  VerificationRunItem,
} from "./types";

// ---------------------------------------------------------------------------
// Preview fixtures. They are drawn from the coupon-race demo so the workbench
// can be reviewed without a populated server; every workspace that renders
// them also says "preview dataset" so they are never mistaken for live evidence.
// ---------------------------------------------------------------------------

export const SAMPLE_FINDINGS: FindingItem[] = [
  {
    id: "f-1",
    fingerprint: "fp_a19c4d28e70b",
    ruleId: "secrets/aws-access-key-id",
    ruleTitle: "AWS access key ID in source",
    category: "secrets",
    severity: "critical",
    path: "fixtures/security/src/config.ts",
    line: 14,
    column: 21,
    snippet: 'export const AWS_KEY = "AKIA…";',
    explanation:
      "A 20-character string matching the AWS access key ID format appears in source. A key committed to version control must be treated as compromised.",
    remediation:
      "Revoke the key in IAM, then move the credential to an external secret store and inject it through the environment.",
  },
  {
    id: "f-2",
    fingerprint: "fp_b831fa09192c",
    ruleId: "security/tls-verification-disabled",
    ruleTitle: "TLS certificate verification disabled",
    category: "security",
    severity: "high",
    path: "fixtures/security/src/tls.ts",
    line: 8,
    column: 3,
    snippet: "rejectUnauthorized: false,",
    explanation:
      "Disabling certificate verification allows an adversary in the middle of the connection to present any certificate and read or alter the traffic.",
    remediation:
      "Remove rejectUnauthorized: false. For an internal CA, add it as a trusted root instead of disabling verification.",
  },
  {
    id: "f-3",
    fingerprint: "fp_c420ea81f9a0",
    ruleId: "security/shell-enabled-subprocess",
    ruleTitle: "Child process executed with shell: true",
    category: "security",
    severity: "high",
    path: "fixtures/security/src/run.ts",
    line: 19,
    column: 5,
    snippet: 'spawn("sh", ["-c", userCommand], { shell: true })',
    explanation:
      "Passing a string through the system shell means any metacharacter in the value becomes shell syntax, which is command injection.",
    remediation:
      "Run the executable directly with shell: false and pass each argument as its own array element.",
  },
  {
    id: "f-4",
    fingerprint: "fp_d90184b2ef61",
    ruleId: "quality/react-dangerouslysetinnerhtml",
    ruleTitle: "Unsanitized dangerouslySetInnerHTML",
    category: "quality",
    severity: "medium",
    path: "fixtures/security/src/profile.tsx",
    line: 32,
    column: 11,
    snippet: "<div dangerouslySetInnerHTML={{ __html: userBio }} />",
    explanation:
      "Raw HTML assigned through dangerouslySetInnerHTML bypasses React's escaping, so user content becomes markup and script.",
    remediation: "Sanitize with DOMPurify before rendering, or render the text as a text node.",
  },
  {
    id: "f-5",
    fingerprint: "fp_e771239aa801",
    ruleId: "quality/todo-comment",
    ruleTitle: "Unresolved TODO marker",
    category: "quality",
    severity: "info",
    path: "fixtures/security/src/notes.ts",
    line: 4,
    column: 1,
    snippet: "// TODO: implement rate limiting before public release",
    explanation:
      "An inline marker records unfinished work with no owner and no tracking issue, so it is easy to ship.",
    remediation: "File the work in the issue tracker and delete the marker.",
  },
  {
    id: "f-6",
    fingerprint: "fp_f5520a71c3d4",
    ruleId: "smell/async-without-await",
    ruleTitle: "Async function with no await",
    category: "smell",
    severity: "low",
    path: "apps/api/src/routes/health.ts",
    line: 12,
    column: 1,
    snippet: "export async function health() {",
    explanation:
      "The function is declared async but never awaits, so callers get a promise for no benefit and rejections lose their stack context.",
    remediation: "Drop async unless a promise is awaited, or await the work it is wrapping.",
  },
];

export const SAMPLE_CHANGES: DiffFileChange[] = [
  {
    path: "examples/shopping-api/src/coupons.ts",
    status: "modified",
    additions: 9,
    deletions: 4,
    diff: `--- a/examples/shopping-api/src/coupons.ts
+++ b/examples/shopping-api/src/coupons.ts
@@ -42,8 +42,13 @@ export async function redeemCoupon(db, userId, couponId) {
-  const existing = await db.query(
-    'SELECT 1 FROM redemptions WHERE user_id = $1 AND coupon_id = $2',
-    [userId, couponId],
-  );
-  if (existing.rowCount > 0) return { success: false, reason: 'ALREADY_REDEEMED' };
+  const res = await db.query(
+    'INSERT INTO redemptions (user_id, coupon_id) VALUES ($1, $2) ON CONFLICT (user_id, coupon_id) DO NOTHING',
+    [userId, couponId],
+  );
+  if (res.rowCount === 0) return { success: false, reason: 'ALREADY_REDEEMED' };
   return { success: true };
 }`,
  },
  {
    path: "examples/shopping-api/migrations/002_unique_redemptions.sql",
    status: "added",
    additions: 4,
    deletions: 0,
    diff: `--- /dev/null
+++ b/examples/shopping-api/migrations/002_unique_redemptions.sql
@@ -0,0 +1,4 @@
+-- Enforce composite uniqueness so a race cannot insert twice
+CREATE UNIQUE INDEX idx_redemptions_user_coupon
+ON redemptions (user_id, coupon_id);
`,
  },
  {
    path: "examples/shopping-api/src/legacy-coupons.ts",
    status: "removed",
    additions: 0,
    deletions: 26,
    diff: `--- a/examples/shopping-api/src/legacy-coupons.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-import { redeemCoupon } from './coupons.js';
-
-// Superseded by the atomic insert in coupons.ts.
-export const redeemLegacy = redeemCoupon;
-`,
  },
];

export const SAMPLE_IMPACT: ImpactChainItem[] = [
  {
    changedFile: "examples/shopping-api/src/coupons.ts",
    symbol: "redeemCoupon",
    edgeKind: "call",
    callers: [{ symbol: "POST /coupons/:id/redeem", file: "examples/shopping-api/src/routes/coupons.ts", line: 24 }],
    testFiles: [
      "examples/shopping-api/test/coupon.test.ts",
      "examples/shopping-api/reproductions/coupon-race.test.ts",
    ],
  },
  {
    changedFile: "examples/shopping-api/migrations/002_unique_redemptions.sql",
    symbol: "redemptions_user_coupon",
    edgeKind: "dynamic",
    callers: [{ symbol: "migrate", file: "examples/shopping-api/src/db/migrate.ts", line: 11 }],
    testFiles: ["examples/shopping-api/test/migrate.test.ts"],
  },
  {
    changedFile: "examples/shopping-api/src/legacy-coupons.ts",
    symbol: "redeemLegacy",
    edgeKind: "import",
    callers: [],
    testFiles: [],
  },
];

export const SAMPLE_REQUIREMENTS: RequirementItem[] = [
  {
    id: "coupon.single-redemption",
    statement: "A coupon can be redeemed at most once per user under concurrent attempts.",
    status: "accepted",
    digest: "sha256:b145f0b05b07d107a90f84a32cd188f76e01a8c8",
    acceptedBy: "afreed",
    acceptedAt: "2026-10-26T05:10:20Z",
    checks: [
      {
        id: "coupon-first-use",
        testPath: "examples/shopping-api/test/coupon.test.ts",
        testName: "coupon redemption > a user redeems a coupon once",
        fingerprint: "t_5ef57445f131c722",
        status: "passed",
      },
      {
        id: "coupon-repeated-use",
        testPath: "examples/shopping-api/test/coupon.test.ts",
        testName: "coupon redemption > a repeated redemption is rejected",
        fingerprint: "t_98ae5310e259f042",
        status: "passed",
      },
      {
        id: "coupon-concurrent-use",
        testPath: "examples/shopping-api/reproductions/coupon-race.test.ts",
        testName: "coupon concurrent redemptions by one user redeem the coupon once",
        fingerprint: "t_b73bd648aba98ad5",
        status: "passed",
      },
    ],
  },
  {
    id: "coupon.expiry-honoured",
    statement: "A coupon past its expiry is refused with 409 and no redemption row is written.",
    status: "stale",
    digest: "sha256:9c2f1a77be0d4c1e5a8b3f2071d9c6ab44ee1f02",
    acceptedBy: "afreed",
    acceptedAt: "2026-10-24T09:02:11Z",
    checks: [
      {
        id: "coupon-expired",
        testPath: "examples/shopping-api/test/coupon-expiry.test.ts",
        testName: "coupon redemption > an expired coupon is refused",
        fingerprint: "t_71bc0d2f5aa93e18",
        status: "failed",
      },
    ],
  },
];

export const SAMPLE_RUNS: VerificationRunItem[] = [
  {
    id: "run_8f9104b2a3cd",
    capturedAt: new Date(Date.now() - 3600000).toISOString(),
    kind: "demo",
    outcome: "verified",
    isolation: "source-copy",
    repository: "shopping-api",
    commit: "3c1d9aa",
    totalTests: 4,
    passedCount: 4,
    failedCount: 0,
    durationMs: 2780,
    results: [
      {
        name: "coupon redemption > a user redeems a coupon once",
        file: "examples/shopping-api/test/coupon.test.ts",
        status: "passed",
        durationMs: 42,
        fingerprint: "t_5ef57445f131c722",
      },
      {
        name: "coupon redemption > a repeated redemption is rejected",
        file: "examples/shopping-api/test/coupon.test.ts",
        status: "passed",
        durationMs: 38,
        fingerprint: "t_98ae5310e259f042",
      },
      {
        name: "coupon concurrent redemptions by one user redeem the coupon once",
        file: "examples/shopping-api/reproductions/coupon-race.test.ts",
        status: "passed",
        durationMs: 145,
        fingerprint: "t_b73bd648aba98ad5",
      },
      {
        name: "health check route responds with 200 ok",
        file: "examples/shopping-api/test/health.test.ts",
        status: "passed",
        durationMs: 19,
        fingerprint: "t_2039aa81f9a2001e",
      },
    ],
  },
  {
    id: "run_baseline_coupon_race",
    capturedAt: new Date(Date.now() - 7200000).toISOString(),
    kind: "reproduction",
    outcome: "reproduced",
    isolation: "source-copy",
    repository: "shopping-api",
    commit: "3c1d9aa",
    totalTests: 3,
    passedCount: 1,
    failedCount: 1,
    durationMs: 2510,
    results: [
      {
        name: "coupon concurrent redemptions by one user redeem the coupon once",
        file: "examples/shopping-api/reproductions/coupon-race.test.ts",
        status: "failed",
        durationMs: 120,
        fingerprint: "t_b73bd648aba98ad5",
        errorMessage:
          "AssertionError: expected 1 accepted redemption, observed 8 accepted responses and 8 stored redemptions",
      },
      {
        name: "coupon redemption > a user redeems a coupon once",
        file: "examples/shopping-api/test/coupon.test.ts",
        status: "passed",
        durationMs: 44,
        fingerprint: "t_5ef57445f131c722",
      },
      {
        name: "coupon redemption > rejects a malformed coupon code",
        file: "examples/shopping-api/test/coupon.test.ts",
        status: "timed_out",
        durationMs: 30000,
        fingerprint: "t_0e2a7c91ab4413dd",
        errorMessage: "runner killed after the 30000ms deadline",
      },
    ],
  },
];

export const SAMPLE_REPRODUCTION: ReproductionItem = {
  id: "coupon-race",
  requirementId: "coupon.single-redemption",
  title: "concurrent redemptions by one user redeem the coupon once",
  verdict: "reproduced",
  expected: "Exactly one of eight concurrent redemptions is accepted; seven are refused.",
  observed:
    "8 of 8 concurrent redemptions were accepted and 8 rows were stored, so the check failed as expected against this tree.",
  testPath: "examples/shopping-api/reproductions/coupon-race.test.ts",
  testName: "coupon concurrent redemptions by one user redeem the coupon once",
  fingerprint: "t_b73bd648aba98ad5",
  attempts: 3,
  failingAttempts: 3,
};

export const SAMPLE_BUNDLES: EvidenceBundleItem[] = [
  {
    id: "bundle_coupon_race",
    kind: "reproduction",
    reportPath: ".codecitadel/demo/coupon-race/reproduction.json",
    bundlePath: ".codecitadel/bundles/bundle_coupon_race.bundle.json",
    digest: "sha256:4b1c8e0f7d92a6b3c5e1d84f09a2be7c6d3f15a8c9e07b2d4f6a1c3e5b8d0f92",
    verified: true,
    artifacts: [
      { name: "coupon-race.test.ts", bytes: 2140, digest: "sha256:8d2a…f41c" },
      { name: "reproduction.json", bytes: 6180, digest: "sha256:1f7c…9a02" },
    ],
  },
  {
    id: "bundle_patch_verify",
    kind: "patch-verification",
    reportPath: ".codecitadel/demo/coupon-race/patch-verify.json",
    bundlePath: ".codecitadel/bundles/bundle_patch_verify.bundle.json",
    digest: "sha256:c03e5a19b7d4f28e6c1a9b5403de7f82a6c4e1d09b7f35a2c8e6d4b1f90a3c57",
    verified: false,
    artifacts: [],
  },
];

export const SAMPLE_PATCH_PROPOSAL: PatchProposalItem = {
  id: "patch-001",
  title: "Enforce coupon uniqueness constraint and handle the conflict atomically",
  patchFile: "examples/shopping-api/patches/0001-coupon-single-redemption.patch",
  verdict: "verified",
  diff: `--- a/examples/shopping-api/src/coupons.ts
+++ b/examples/shopping-api/src/coupons.ts
@@ -40,10 +40,12 @@ export async function redeemCoupon(db, userId, couponId) {
-  const existing = await db.query(
-    'SELECT 1 FROM redemptions WHERE user_id = $1 AND coupon_id = $2',
-    [userId, couponId],
-  );
-  if (existing.rowCount > 0) return { success: false, reason: 'ALREADY_REDEEMED' };
+  const res = await db.query(
+    'INSERT INTO redemptions (user_id, coupon_id) VALUES ($1, $2) ON CONFLICT (user_id, coupon_id) DO NOTHING',
+    [userId, couponId],
+  );
+  if (res.rowCount === 0) return { success: false, reason: 'ALREADY_REDEEMED' };
   return { success: true };
 }`,
  weakeningSignals: [],
  comparison: { fixed: 1, stillPassing: 3, newlyFailing: 0, stillFailing: 0 },
  transitions: [
    {
      name: "coupon concurrent redemptions by one user redeem the coupon once",
      file: "examples/shopping-api/reproductions/coupon-race.test.ts",
      fingerprint: "t_b73bd648aba98ad5",
      before: "failed",
      after: "passed",
    },
    {
      name: "coupon redemption > a user redeems a coupon once",
      file: "examples/shopping-api/test/coupon.test.ts",
      fingerprint: "t_5ef57445f131c722",
      before: "passed",
      after: "passed",
    },
    {
      name: "coupon redemption > a repeated redemption is rejected",
      file: "examples/shopping-api/test/coupon.test.ts",
      fingerprint: "t_98ae5310e259f042",
      before: "passed",
      after: "passed",
    },
  ],
};

/** A rejected patch, kept so the weakening inspector can be reviewed offline. */
export const SAMPLE_WEAKENING_PATCH: PatchProposalItem = {
  id: "patch-002",
  title: "Make the concurrency reproduction pass by relaxing its assertions",
  patchFile: "examples/shopping-api/patches/0002-relax-race-test.patch",
  verdict: "not_verified",
  diff: `--- a/examples/shopping-api/reproductions/coupon-race.test.ts
+++ b/examples/shopping-api/reproductions/coupon-race.test.ts
@@ -12,8 +12,9 @@ describe('coupon concurrent redemptions', () => {
   it('by one user redeem the coupon once', async () => {
     const responses = await Promise.all(attempts.map(attempt));
-    const accepted = responses.filter((response) => response.status === 200);
-    expect(accepted).toHaveLength(1);
-    expect(await countRedemptions(db, userId, couponId)).toBe(1);
+    // @ts-expect-error asserting the happy path is enough here
+    const accepted = responses.filter((response) => response.status === 200);
+    expect(accepted.length).toBeGreaterThanOrEqual(0);
   });
 });`,
  weakeningSignals: [
    {
      kind: "dropped-assertions",
      location: "examples/shopping-api/reproductions/coupon-race.test.ts:16",
      message: "The assertion that exactly one redemption was stored was deleted.",
    },
    {
      kind: "dropped-assertions",
      location: "examples/shopping-api/reproductions/coupon-race.test.ts:17",
      message: "toHaveLength(1) became toBeGreaterThanOrEqual(0), which no outcome can fail.",
    },
    {
      kind: "suppressed-diagnostics",
      location: "examples/shopping-api/reproductions/coupon-race.test.ts:15",
      message: "@ts-expect-error suppresses the type error the patch introduced.",
    },
  ],
  comparison: { fixed: 0, stillPassing: 2, newlyFailing: 0, stillFailing: 1 },
  transitions: [
    {
      name: "coupon concurrent redemptions by one user redeem the coupon once",
      file: "examples/shopping-api/reproductions/coupon-race.test.ts",
      fingerprint: "t_b73bd648aba98ad5",
      before: "failed",
      after: "passed",
    },
    {
      name: "coupon redemption > a user redeems a coupon once",
      file: "examples/shopping-api/test/coupon.test.ts",
      fingerprint: "t_5ef57445f131c722",
      before: "passed",
      after: "passed",
    },
  ],
};
