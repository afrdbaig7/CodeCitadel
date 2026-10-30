import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  reproductionReportSchema,
  runDetailResponseSchema,
  runListResponseSchema,
  type ReproductionReport,
} from "@codecitadel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const serverEntry = path.join(repoRoot, "apps", "api", "dist", "main.js");
const fixture = path.join(repoRoot, "fixtures", "execution");
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-upload-e2e-"));

const TOKEN = "cc_upload_e2e_token";

let server: ChildProcess;
let serverLog = "";
let baseUrl = "";
let reportPath = "";
let report: ReproductionReport;

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const run = await exec(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, stdout: run.stdout, stderr: run.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 2, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * A port nothing is listening on right now. The kernel picks it, the probe is
 * closed, and the server binds it a moment later — the usual way to let a test
 * start a real listener without a fixed port that two suites can collide on.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/health`);
      if (response.status === 200) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The control plane never answered on ${url}.\n${serverLog}`);
}

async function api(pathname: string, token = TOKEN): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
}

async function storedRunIds(): Promise<string[]> {
  const response = await api("/api/v1/runs?limit=200");
  return runListResponseSchema.parse(await response.json()).runs.map((run) => run.id);
}

/**
 * A real reproduction report, produced by the real CLI against a real Vitest in
 * a copy of the execution fixture. Uploading a hand-written document would test
 * the schema, not the round trip this command exists for.
 */
async function buildReport(): Promise<void> {
  const tree = path.join(scratch, "tree");
  mkdirSync(tree, { recursive: true });
  cpSync(fixture, tree, { recursive: true });
  mkdirSync(path.join(tree, "reproductions"), { recursive: true });
  writeFileSync(
    path.join(tree, "reproductions", "negative.test.ts"),
    `import { describe, expect, it } from "vitest";
import { add } from "../src/math";

describe("math", () => {
  it("negative sum", () => {
    expect(add(-2, -1)).toBe(-4); // deliberate failure: -3 != -4
  });
});
`,
    "utf8",
  );

  const manifest = path.join(scratch, "reproductions.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        schemaVersion: 1,
        reproductions: [
          {
            id: "math.negative-sum",
            requirement: null,
            statement: "add returns arithmetic sum for negative operands.",
            provenance: "user-authored",
            file: "reproductions/negative.test.ts",
            test: "math negative sum",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  reportPath = path.join(scratch, "reproduction.json");
  const produced = await cli([
    "reproduce",
    "run",
    manifest,
    tree,
    "--id",
    "math.negative-sum",
    "--runner",
    vitestEntry,
    "--format",
    "json",
    "--out",
    reportPath,
  ]);
  if (produced.code !== 0) {
    throw new Error(`reproduce run exited ${produced.code}: ${produced.stderr}`);
  }
  report = reproductionReportSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")));
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      serverEntry,
      "--port",
      String(port),
      "--data-dir",
      path.join(scratch, "server"),
      "--token",
      TOKEN,
      "--organization",
      "acme",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString("utf8");
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString("utf8");
  });

  await waitForHealth(baseUrl);
  await buildReport();
}, 180_000);

afterAll(async () => {
  if (server !== undefined && server.exitCode === null && server.pid !== undefined) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
    }
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("codecitadel upload e2e", () => {
  it("stores the report the CLI produced and reads it back unchanged", { timeout: 120_000 }, async () => {
    const artifactPath = path.join(scratch, "trace.txt");
    writeFileSync(artifactPath, "first failure trace\n", "utf8");

    const uploaded = await cli([
      "upload",
      reportPath,
      "--server",
      baseUrl,
      "--token",
      TOKEN,
      "--commit",
      "abc123",
      "--branch",
      "main",
      "--artifact",
      artifactPath,
      "--format",
      "json",
    ]);

    expect(uploaded.code).toBe(0);
    expect(uploaded.stdout).not.toContain(TOKEN);
    expect(uploaded.stderr).not.toContain(TOKEN);

    const stored = JSON.parse(uploaded.stdout);
    expect(stored.run.kind).toBe("reproduction");
    expect(stored.run.origin).toBe("local");
    expect(stored.run.outcome).toBe("reproduced");
    expect(stored.run.repository.name).toBe("tree");
    expect(stored.run.repository.commit).toBe("abc123");
    // The capture time is the report's own timestamp, not the upload time.
    expect(stored.run.capturedAt).toBe(report.generatedAt);

    const detail = runDetailResponseSchema.parse(await (await api(`/api/v1/runs/${stored.run.id}`)).json());
    expect(detail.report).toEqual(report);

    const artifact = await api(`/api/v1/runs/${stored.run.id}/artifacts/trace.txt`);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("x-codecitadel-digest")).toBe(
      stored.run.artifacts[0].digest,
    );
    expect(Buffer.from(await artifact.arrayBuffer()).toString("utf8")).toBe("first failure trace\n");
  });

  it("takes the token from the environment, the way CI would supply it", { timeout: 120_000 }, async () => {
    const uploaded = await cli(["upload", reportPath, "--server", baseUrl], {
      CODECITADEL_TOKEN: TOKEN,
    });
    expect(uploaded.code).toBe(0);
    expect(uploaded.stdout).toContain("uploaded reproduction report");
    expect(uploaded.stdout).not.toContain(TOKEN);
    expect(uploaded.stderr).not.toContain(TOKEN);
  });

  it("reports a refused token with the control plane's own words", { timeout: 120_000 }, async () => {
    const refused = await cli([
      "upload",
      reportPath,
      "--server",
      baseUrl,
      "--token",
      "cc_not_a_real_token",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("(401)");
    expect(refused.stderr).toContain("not recognized");
  });

  it("refuses a file that is no report, and a kind the file does not satisfy", { timeout: 120_000 }, async () => {
    const notAReport = path.join(scratch, "not-a-report.json");
    writeFileSync(notAReport, JSON.stringify({ hello: "world" }), "utf8");

    const unknown = await cli([
      "upload",
      notAReport,
      "--server",
      baseUrl,
      "--token",
      TOKEN,
    ]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("matches none of the 8 report contracts");

    const wrongKind = await cli([
      "upload",
      reportPath,
      "--server",
      baseUrl,
      "--token",
      TOKEN,
      "--kind",
      "scan",
    ]);
    expect(wrongKind.code).toBe(2);
    expect(wrongKind.stderr).toContain("does not match the scan report contract");
  });

  it("refuses an artifact it cannot store, before the network is touched", { timeout: 120_000 }, async () => {
    const before = await storedRunIds();

    const badlyNamed = path.join(scratch, "Weird Name.json");
    writeFileSync(badlyNamed, "{}\n", "utf8");
    const refusedName = await cli([
      "upload",
      reportPath,
      "--server",
      baseUrl,
      "--token",
      TOKEN,
      "--artifact",
      badlyNamed,
    ]);
    expect(refusedName.code).toBe(2);
    expect(refusedName.stderr).toContain("not a portable artifact name");

    const oversized = path.join(scratch, "big.txt");
    writeFileSync(oversized, Buffer.alloc(64 * 1024 * 1024 + 1));
    const refusedSize = await cli([
      "upload",
      reportPath,
      "--server",
      baseUrl,
      "--token",
      TOKEN,
      "--artifact",
      oversized,
    ]);
    expect(refusedSize.code).toBe(2);
    expect(refusedSize.stderr).toContain("more than the per-artifact limit");

    expect(await storedRunIds()).toEqual(before);
  });

  it("refuses to claim managed execution", { timeout: 120_000 }, async () => {
    const refused = await cli([
      "upload",
      reportPath,
      "--server",
      baseUrl,
      "--token",
      TOKEN,
      "--origin",
      "managed",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("never asserted by the client");
  });

  it("refuses to put a bearer token on plaintext http to a remote host", { timeout: 120_000 }, async () => {
    const refused = await cli([
      "upload",
      reportPath,
      "--server",
      "http://example.com:4317",
      "--token",
      TOKEN,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("plaintext http");
  });

  it("reports an unreachable control plane instead of retrying silently", { timeout: 120_000 }, async () => {
    const port = await freePort();
    const refused = await cli([
      "upload",
      reportPath,
      "--server",
      `http://127.0.0.1:${port}`,
      "--token",
      TOKEN,
      "--timeout-ms",
      "5000",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("Cannot reach the control plane");
  });
});
