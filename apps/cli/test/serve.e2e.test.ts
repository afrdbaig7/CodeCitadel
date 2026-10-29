import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = path.join(repoRoot, "apps", "cli", "dist", "index.js");
const scratch = mkdtempSync(path.join(tmpdir(), "codecitadel-serve-e2e-"));

let server: ChildProcess | null = null;
let baseUrl = "";
let serverLog = "";

/** A port nothing is listening on, picked by the kernel and then released. */
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
  throw new Error(`The local server never answered on ${url}.\n${serverLog}`);
}

/** A built-dashboard stand-in: only the files the server is asked to serve. */
function writeDashboard(): string {
  const dir = path.join(scratch, "dashboard");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(
    path.join(dir, "index.html"),
    '<!DOCTYPE html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>\n',
    "utf8",
  );
  writeFileSync(path.join(dir, "assets", "app.js"), "export const served = true;\n", "utf8");
  return dir;
}

/** Waits for the child to exit so its SQLite handle is released before cleanup. */
async function stopServer(): Promise<void> {
  const current = server;
  server = null;
  if (current === null || current.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    current.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    current.kill();
  });
}

describe("codecitadel serve", () => {
  beforeAll(async () => {
    const dashboard = writeDashboard();
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [
        cliEntry,
        "serve",
        "--port",
        String(port),
        "--no-open",
        "--dashboard",
        dashboard,
        "--data-dir",
        path.join(scratch, "db"),
        "--organization",
        "serve-e2e",
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      serverLog += chunk.toString();
    });
    await waitForHealth(baseUrl);
  }, 40_000);

  afterAll(async () => {
    await stopServer();
    // Windows keeps a directory handle briefly after the child exits.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(scratch, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }, 10_000);

  it("prints the issued token and serves the health document", async () => {
    expect(serverLog).toMatch(/token cc_[0-9a-f]{48}/);
    expect(serverLog).toContain(`listening on ${baseUrl}`);
    const response = await fetch(`${baseUrl}/api/v1/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; limitations: string[] };
    expect(body.status).toBe("ok");
    expect(body.limitations.join(" ")).toContain("never executes repository code");
  });

  it("serves the dashboard with a same-site session cookie", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("codecitadel_session=cc_");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(await response.text()).toContain('<div id="root">');
  });

  it("refuses an unauthenticated read and accepts the cookie the page set", async () => {
    const anonymous = await fetch(`${baseUrl}/api/v1/runs`);
    expect(anonymous.status).toBe(401);

    const page = await fetch(`${baseUrl}/`);
    const session = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const authenticated = await fetch(`${baseUrl}/api/v1/runs`, { headers: { cookie: session } });
    expect(authenticated.status).toBe(200);
    const body = (await authenticated.json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it("accepts the printed token as a bearer credential for the CLI", async () => {
    const token = /token (cc_[0-9a-f]{48})/.exec(serverLog)?.[1];
    expect(token).toBeDefined();
    const response = await fetch(`${baseUrl}/api/v1/runs`, {
      headers: { authorization: `Bearer ${token ?? ""}` },
    });
    expect(response.status).toBe(200);
  });

  it("serves a built asset and refuses a path outside it", async () => {
    writeFileSync(path.join(scratch, "secret.txt"), "this file is not part of the dashboard\n", "utf8");

    const asset = await fetch(`${baseUrl}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toContain("served");

    const traversal = await fetch(`${baseUrl}/assets/%2e%2e%2fsecret.txt`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain("not part of the dashboard");
  });

  it("refuses a port another server already holds instead of reporting success", async () => {
    const port = new URL(baseUrl).port;
    try {
      const run = await exec(process.execPath, [cliEntry, "serve", "--port", port, "--no-open"], {
        cwd: repoRoot,
        timeout: 30_000,
      });
      throw new Error(`serve should have failed, but exited 0: ${run.stdout}`);
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      expect(failure.code).toBe(2);
      expect(failure.stderr ?? "").toContain("cannot start the local server");
    }
  }, 40_000);
});
