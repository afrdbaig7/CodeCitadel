#!/usr/bin/env node
import path from "node:path";

import { startLocalServer } from "./local.js";

interface StartOptions {
  port: number;
  host: string;
  dataDir: string;
  databaseUrl: string | undefined;
  maxDatabaseConnections: number;
  organizationSlug: string;
  token: string | undefined;
}

function parseArgs(argv: readonly string[]): StartOptions {
  const options: StartOptions = {
    port: 4317,
    host: "127.0.0.1",
    dataDir: path.resolve(".codecitadel", "server"),
    databaseUrl: process.env.CODECITADEL_DATABASE_URL,
    maxDatabaseConnections: 5,
    organizationSlug: "local",
    token: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--port": {
        if (value === undefined || !/^\d+$/.test(value)) {
          throw new Error("--port needs a number.");
        }
        options.port = Number.parseInt(value, 10);
        index += 1;
        break;
      }
      case "--data-dir": {
        if (value === undefined) {
          throw new Error("--data-dir needs a path.");
        }
        options.dataDir = path.resolve(value);
        index += 1;
        break;
      }
      case "--database-url": {
        if (value === undefined || value.trim() === "") {
          throw new Error("--database-url needs a PostgreSQL connection string.");
        }
        options.databaseUrl = value;
        index += 1;
        break;
      }
      case "--max-db-connections": {
        if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
          throw new Error("--max-db-connections must be an integer from 1 to 100.");
        }
        options.maxDatabaseConnections = Number.parseInt(value, 10);
        index += 1;
        break;
      }
      case "--organization": {
        if (value === undefined || value.trim() === "") {
          throw new Error("--organization needs a slug.");
        }
        options.organizationSlug = value.trim();
        index += 1;
        break;
      }
      case "--token": {
        if (value === undefined || value.trim() === "") {
          throw new Error("--token needs a value.");
        }
        options.token = value.trim();
        index += 1;
        break;
      }
      case "--help": {
        process.stdout.write(
          [
            "Usage: codecitadel-server [options]",
            "",
            "  --port <n>            listen port (default 4317)",
            "  --data-dir <dir>      SQLite database and artifact directory (PostgreSQL artifacts use this directory)",
            "  --database-url <url>  PostgreSQL connection string (or CODECITADEL_DATABASE_URL)",
            "  --max-db-connections <n>  PostgreSQL pool size (default: 5)",
            "  --organization <slug> organization the token belongs to (default local)",
            "  --token <value>       use this bearer token instead of generating one",
            "",
            "Binds to 127.0.0.1 only: this is a local control plane, not a hosted service.",
            "For the dashboard, use `codecitadel serve` in the CLI.",
            "",
          ].join("\n"),
        );
        process.exit(0);
      }
      default: {
        if (flag !== undefined && flag.startsWith("--")) {
          throw new Error(`Unknown option ${flag}. Use --help.`);
        }
      }
    }
  }
  return options;
}

async function main(): Promise<number> {
  let options: StartOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`codecitadel-server: ${(error as Error).message}\n`);
    return 2;
  }

  let server;
  try {
    server = await startLocalServer({
      port: options.port,
      host: options.host,
      dataDir: options.dataDir,
      ...(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl }),
      maxDatabaseConnections: options.maxDatabaseConnections,
      organizationSlug: options.organizationSlug,
      ...(options.token === undefined ? {} : { token: options.token }),
    });
  } catch (error) {
    process.stderr.write(`codecitadel-server: cannot start: ${(error as Error).message}\n`);
    return 2;
  }

  process.stdout.write(
    [
      `codecitadel local API ${server.schemaVersion} listening on ${server.url}`,
      `organization ${server.organization.slug} (${server.organization.id})`,
      `token ${server.token}`,
      `storage ${options.databaseUrl === undefined ? "sqlite" : "postgres"} · ${server.dataFile}`,
      "This is a local control plane. It validates and stores uploaded evidence; it does not execute code.",
      options.token === undefined ? "" : "(--token was provided, so a new token was also issued.)",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return 0;
}

void main().then((code) => {
  if (code !== 0) {
    process.exitCode = code;
  }
});
