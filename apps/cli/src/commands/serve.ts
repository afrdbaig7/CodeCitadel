import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { EXIT_CODES } from "@codecitadel/contracts";

import { parsePositiveInt, UsageError } from "../errors.js";

export interface ServeCommandOptions {
  port?: string;
  host?: string;
  dataDir?: string;
  databaseUrl?: string;
  maxDatabaseConnections?: string;
  organization?: string;
  token?: string;
  dashboard?: string;
  /** Commander sets this to false for `--no-open`. */
  open?: boolean;
}

const DEFAULT_PORT = 4317;

function postgresSelected(options: ServeCommandOptions): boolean {
  return options.databaseUrl !== undefined || process.env.CODECITADEL_DATABASE_URL !== undefined;
}

/**
 * Where a built dashboard normally sits in this repository. The CLI is not a
 * dashboard build tool: if the assets are absent, the command says so and serves
 * the API only, rather than pretending there is a UI.
 */
function defaultDashboardDir(): string {
  return path.resolve(import.meta.dirname, "../../../dashboard/dist");
}

function resolveDashboardDir(explicit: string | undefined): string | null {
  if (explicit !== undefined) {
    const resolved = path.resolve(explicit);
    if (!existsSync(path.join(resolved, "index.html"))) {
      throw new UsageError(
        `--dashboard ${explicit} does not contain index.html. Point it at a built dashboard directory.`,
      );
    }
    return resolved;
  }
  const candidate = defaultDashboardDir();
  return existsSync(path.join(candidate, "index.html")) ? candidate : null;
}

/** Opens a URL with the platform's own handler; never throws at the caller. */
function openBrowser(url: string): boolean {
  const command =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // A missing handler is not fatal: the URL is printed either way.
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * `codecitadel serve` runs until interrupted.
 *
 * The browser and the CLI share one ephemeral token: the CLI prints it so
 * `codecitadel upload` can use it, and the server sets it as an HttpOnly
 * same-site cookie when it serves the dashboard. No token goes in a URL.
 */
export async function runServeCommand(options: ServeCommandOptions): Promise<number> {
  const port = options.port === undefined ? DEFAULT_PORT : parsePositiveInt(options.port, "--port");
  if (port > 65535) {
    throw new UsageError(`--port must be a TCP port between 1 and 65535, received ${port}.`);
  }
  const host = options.host ?? "127.0.0.1";
  const dashboardDir = resolveDashboardDir(options.dashboard);
  const databaseUrl = options.databaseUrl ?? process.env.CODECITADEL_DATABASE_URL;
  const maxDatabaseConnections =
    options.maxDatabaseConnections === undefined
      ? undefined
      : parsePositiveInt(options.maxDatabaseConnections, "--max-db-connections");
  if (maxDatabaseConnections !== undefined && maxDatabaseConnections > 100) {
    throw new UsageError("--max-db-connections must be between 1 and 100.");
  }

  // Loaded here, not at module scope: short-lived commands avoid server/storage startup dependencies.
  const { startLocalServer } = await import("@codecitadel/api");

  let server;
  try {
    server = await startLocalServer({
      port,
      host,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(databaseUrl === undefined ? {} : { databaseUrl }),
      ...(maxDatabaseConnections === undefined ? {} : { maxDatabaseConnections }),
      ...(options.organization === undefined ? {} : { organizationSlug: options.organization }),
      ...(options.token === undefined ? {} : { token: options.token }),
      dashboardDir,
    });
  } catch (error) {
    throw new UsageError(`cannot start the local server: ${(error as Error).message}`);
  }

  const url = server.url;
  const lines = [
    `codecitadel local API ${server.schemaVersion} listening on ${url}`,
    dashboardDir === null
      ? "dashboard not built: run `pnpm --filter @codecitadel/dashboard build`, then start again (the API is available now)."
      : `dashboard ${url}/`,
    `token ${server.token}`,
    `storage ${postgresSelected(options) ? "postgres" : "sqlite"} · ${server.dataFile}`,
    "Press Ctrl+C to stop. This control plane validates and stores evidence; it does not execute repository code.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  if (dashboardDir !== null && options.open !== false && !openBrowser(`${url}/`)) {
    process.stderr.write("codecitadel: could not open a browser; visit the dashboard URL above.\n");
  }

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

  await server.close();
  process.stderr.write("codecitadel: server stopped.\n");
  return EXIT_CODES.ok;
}
