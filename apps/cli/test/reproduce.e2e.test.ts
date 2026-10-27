import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { reproductionExportSchema, reproductionReportSchema } from "@codecitadel/contracts";
import { afterAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const fixture = path.join(repoRoot, "fixtures", "execution");
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-reproduce-e2e-"));
let counter = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const run = await exec(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, stdout: run.stdout, stderr: run.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 2, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

const REPRODUCTION = `import { describe, expect, it } from "vitest";

import { redeem } from "../src/coupon";

describe("coupon", () => {
  it("a repeated redemption is rejected", () => {
    expect(redeem("u", "c")).toBe(true);
    expect(redeem("u", "c")).toBe(false);
  });
});
`;

const ENV_REPRODUCTION = `import { describe, expect, it } from "vitest";

describe("coupon", () => {
  it("a repeated redemption is rejected", () => {
    // Present only when the executor forwards it by name from the CLI process.
    expect(process.env.CODECITADEL_DEMO_DB_URL).toBe("postgres://demo");
  });
});
`;

function tree(name: string, test = "coupon a repeated redemption is rejected"): string {
  counter += 1;
  const root = path.join(scratch, `${name}-${counter}`);
  cpSync(fixture, root, { recursive: true });
  mkdirSync(path.join(root, "reproductions"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "coupon.ts"),
    "/** A broken checkout: the second redemption is accepted. */\nexport function redeem(_user: string, _coupon: string): boolean {\n  return true;\n}\n",
    "utf8",
  );
  writeFileSync(path.join(root, "reproductions", "coupon.test.ts"), REPRODUCTION, "utf8");
  writeFileSync(
    path.join(root, "codecitadel.requirements.json"),
    JSON.stringify({
      schemaVersion: 1,
      requirements: [
        {
          id: "coupon.single-redemption",
          statement: "A coupon can be redeemed only once per user.",
          state: "proposed",
          checks: [
            {
              id: "coupon-repeat",
              file: "reproductions/coupon.test.ts",
              name: "coupon a repeated redemption is rejected",
            },
          ],
          acceptance: null,
        },
      ],
    }),
    "utf8",
  );
  return writeFile(
    path.join(root, "reproductions.json"),
    JSON.stringify({
      schemaVersion: 1,
      reproductions: [
        {
          id: "coupon.double-redemption",
          requirement: null,
          statement: "A second redemption by the same user is rejected.",
          provenance: "user-authored",
          file: "reproductions/coupon.test.ts",
          test,
        },
      ],
    }),
  );
}

function writeFile(file: string, content: string): string {
  writeFileSync(file, content, "utf8");
  return file;
}

function report(file: string) {
  return reproductionReportSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const runArgs = (manifestFile: string, extra: string[]) => [
  "reproduce",
  "run",
  manifestFile,
  path.dirname(manifestFile),
  "--id",
  "coupon.double-redemption",
  "--runner",
  vitestEntry,
  ...extra,
];

describe("codecitadel reproduce run", () => {
  it("reproduces a failing check and records the runner facts", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce");
    const out = path.join(scratch, "reproduced.json");
    const result = await cli(runArgs(manifestFile, ["--format", "json", "--out", out]));

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("reproduced:");
    const recorded = report(out);
    expect(recorded.verdict).toBe("reproduced");
    expect(recorded.record?.status).toBe("failed");
    expect(recorded.check.file).toBe("reproductions/coupon.test.ts");
    expect(recorded.result?.status).toBe("failed");
    expect(recorded.requirement).toBeNull();
  });

  it("calls a passing check not reproduced and exits 1", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-pass", "coupon a repeated redemption is rejected");
    const root = path.dirname(manifestFile);
    writeFileSync(
      path.join(root, "reproductions", "coupon.test.ts"),
      REPRODUCTION.replace('expect(redeem("u", "c")).toBe(false);', 'expect(redeem("u", "c")).toBe(true);'),
      "utf8",
    );

    const result = await cli(runArgs(manifestFile, ["--format", "json"]));
    expect(result.code).toBe(1);
    const recorded = JSON.parse(result.stdout);
    expect(recorded.verdict).toBe("not_reproduced");
    expect(recorded.result.status).toBe("passed");
  });

  it("accepts a reproduction linked to an accepted requirement", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-accepted");
    const root = path.dirname(manifestFile);
    await cli(["requirements", "accept", "coupon.single-redemption", root, "--by", "tester"]);
    writeFile(
      manifestFile,
      JSON.stringify({
        schemaVersion: 1,
        reproductions: [
          {
            id: "coupon.double-redemption",
            requirement: "coupon.single-redemption",
            statement: "A second redemption by the same user is rejected.",
            provenance: "user-authored",
            file: "reproductions/coupon.test.ts",
            test: "coupon a repeated redemption is rejected",
          },
        ],
      }),
    );

    const result = await cli(runArgs(manifestFile, ["--format", "json"]));
    expect(result.code).toBe(0);
    const recorded = JSON.parse(result.stdout);
    expect(recorded.verdict).toBe("reproduced");
    expect(recorded.requirement).toEqual({ id: "coupon.single-redemption", state: "accepted", acceptance: "current" });
  });

  it("refuses a reproduction whose requirement is not accepted", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-refused");
    writeFile(
      manifestFile,
      JSON.stringify({
        schemaVersion: 1,
        reproductions: [
          {
            id: "coupon.double-redemption",
            requirement: "coupon.single-redemption",
            statement: "A second redemption by the same user is rejected.",
            provenance: "user-authored",
            file: "reproductions/coupon.test.ts",
            test: "coupon a repeated redemption is rejected",
          },
        ],
      }),
    );

    const result = await cli(runArgs(manifestFile, ["--format", "json"]));
    expect(result.code).toBe(2);
    const recorded = JSON.parse(result.stdout);
    expect(recorded.verdict).toBe("not_accepted");
    expect(recorded.record).toBeNull();
  });

  it("reports a missing test as inconclusive instead of guessing", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-missing", "coupon a test that does not exist");
    const result = await cli(runArgs(manifestFile, ["--format", "json"]));
    expect(result.code).toBe(2);
    const recorded = JSON.parse(result.stdout);
    expect(recorded.verdict).toBe("inconclusive");
    expect(recorded.result).toBeNull();
  });

  it("forwards a named environment variable and records the name", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-env");
    const root = path.dirname(manifestFile);
    writeFileSync(path.join(root, "reproductions", "coupon.test.ts"), ENV_REPRODUCTION, "utf8");

    const out = path.join(scratch, "reproduce-env.json");
    const forwarded = await cli(
      runArgs(manifestFile, ["--format", "json", "--out", out, "--env", "CODECITADEL_DEMO_DB_URL"]),
      { CODECITADEL_DEMO_DB_URL: "postgres://demo" },
    );
    // The check passed, so nothing was reproduced: the variable arrived.
    expect(forwarded.code).toBe(1);
    const recorded = report(out);
    expect(recorded.verdict).toBe("not_reproduced");
    expect(recorded.result?.status).toBe("passed");
    expect(recorded.limitations.join("\n")).toContain(
      "Forwarded environment variables by name: CODECITADEL_DEMO_DB_URL",
    );

    // Without the flag the same check fails, which is what forwarding prevents.
    const withheld = await cli(runArgs(manifestFile, ["--format", "json"]), {
      CODECITADEL_DEMO_DB_URL: "postgres://demo",
    });
    expect(withheld.code).toBe(0);
    expect(JSON.parse(withheld.stdout).verdict).toBe("reproduced");
  });

  it("refuses an environment name it cannot forward", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-env-invalid");
    const result = await cli(runArgs(manifestFile, ["--env", "not-a-name"]));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not an environment variable name");
  });

  it("refuses to run a check when a named variable is not set", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-env-unset");
    const result = await cli(runArgs(manifestFile, ["--env", "CODECITADEL_TEST_UNSET_FOR_E2E"]));

    // Refused before execution: a setup failure must not be classified as a
    // reproduced bug, and no report is written.
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("CODECITADEL_TEST_UNSET_FOR_E2E");
    expect(result.stderr).toContain("not set in this process");
  });

  it("rejects a manifest it does not understand", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-unknown");
    const parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
    parsed.reproductions[0].extra = true;
    writeFile(manifestFile, JSON.stringify(parsed));

    const result = await cli(runArgs(manifestFile, []));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unrecognized key");
  });
});

describe("codecitadel reproduce export", () => {
  it("writes a portable test and an evidence manifest, and the test runs alone", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-export");
    const out = path.join(scratch, "exported-report.json");
    await cli(runArgs(manifestFile, ["--format", "json", "--out", out]));

    const exported = path.join(scratch, "exported-tree");
    const result = await cli(["reproduce", "export", out, "--out", exported]);
    expect(result.code).toBe(0);
    const exportedTest = path.join(exported, "reproductions", "coupon.test.ts");
    const manifestPath = path.join(exported, "coupon.double-redemption.reproduction.json");
    expect(existsSync(exportedTest)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    reproductionExportSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    expect(readFileSync(exportedTest, "utf8")).not.toContain("@codecitadel");

    const portable = path.join(scratch, "portable-tree");
    cpSync(fixture, portable, { recursive: true });
    writeFileSync(
      path.join(portable, "src", "coupon.ts"),
      "export function redeem(_user: string, _coupon: string): boolean {\n  return true;\n}\n",
      "utf8",
    );
    mkdirSync(path.join(portable, "reproductions"), { recursive: true });
    cpSync(exportedTest, path.join(portable, "reproductions", "coupon.test.ts"));
    await symlink(path.join(repoRoot, "node_modules"), path.join(portable, "node_modules"), "junction");

    const runWithoutCodeCitadel = await exec(
      process.execPath,
      [vitestEntry, "run", path.join("reproductions", "coupon.test.ts")],
      { cwd: portable, timeout: 120_000, maxBuffer: 20 * 1024 * 1024 },
    ).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));
    expect(runWithoutCodeCitadel.stderr).toContain("AssertionError");
  });

  it("never overwrites an existing export silently", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-overwrite");
    const out = path.join(scratch, "overwrite-report.json");
    await cli(runArgs(manifestFile, ["--format", "json", "--out", out]));
    const exported = path.join(scratch, "overwrite-tree");
    mkdirSync(path.join(exported, "reproductions"), { recursive: true });
    writeFile(path.join(exported, "reproductions", "coupon.test.ts"), "// existing\n");

    const result = await cli(["reproduce", "export", out, "--out", exported]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("already exists");
    expect(readFileSync(path.join(exported, "reproductions", "coupon.test.ts"), "utf8")).toBe("// existing\n");
  });

  it("refuses to write into the analyzed checkout without --in-root", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-in-root");
    const out = path.join(scratch, "in-root-report.json");
    await cli(runArgs(manifestFile, ["--format", "json", "--out", out]));
    const root = path.dirname(manifestFile);

    const result = await cli(["reproduce", "export", out, "--out", root]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--in-root");
  });

  it("refuses a report whose recorded source digest no longer matches", { timeout: 120_000 }, async () => {
    const manifestFile = tree("reproduce-tamper");
    const out = path.join(scratch, "tamper-report.json");
    await cli(runArgs(manifestFile, ["--format", "json", "--out", out]));
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    parsed.check.source = `${parsed.check.source}\n// edited\n`;
    writeFile(out, JSON.stringify(parsed));

    const result = await cli(["reproduce", "export", out, "--out", path.join(scratch, "tamper-tree")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("inconsistent");
  });

  it("rejects a report it cannot read", { timeout: 120_000 }, async () => {
    const result = await cli([
      "reproduce",
      "export",
      path.join(scratch, "missing-report.json"),
      "--out",
      path.join(scratch, "missing-tree"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Cannot read the reproduction report");
  });
});
