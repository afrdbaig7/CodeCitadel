import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * A Docker engine is an optional host capability, so every failure here is
 * reported as text the operator can act on rather than as a stack trace. The
 * demo is one of the few commands that can start a service on the host, and it
 * only ever starts one container that it names, uses, and removes.
 */
export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerError";
  }
}

async function docker(args: readonly string[], timeoutMs = 60_000): Promise<string> {
  try {
    const { stdout } = await exec("docker", [...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string; message?: string };
    const detail = (failure.stderr ?? failure.message ?? "").trim();
    if (failure.code === "ENOENT") {
      throw new DockerError(
        "Docker is not installed or not on PATH. Install Docker, or pass --database-url to use a PostgreSQL server that is already running.",
      );
    }
    throw new DockerError(
      `docker ${args.join(" ")} failed${typeof failure.code === "number" ? ` with exit ${failure.code}` : ""}: ${detail.slice(0, 400)}`,
    );
  }
}

/** True when an engine answers; false when Docker is missing or not running. */
export async function dockerEngineVersion(): Promise<string | null> {
  try {
    return (await docker(["info", "--format", "{{.ServerVersion}}"], 20_000)) || null;
  } catch {
    return null;
  }
}

export interface StartedContainer {
  name: string;
  /** Server version reported by the database inside the container. */
  serverVersion: string;
}

/**
 * Starts a throwaway PostgreSQL on a host port and waits until it accepts
 * connections. The container runs with `--rm` and a random name this process
 * chose, so it is identifiable and removable, and it holds demo data only: it
 * is never pointed at platform storage.
 */
export async function startPostgresContainer(input: {
  name: string;
  hostPort: number;
  image: string;
  readyTimeoutMs?: number;
}): Promise<StartedContainer> {
  await docker([
    "run",
    "-d",
    "--rm",
    "--name",
    input.name,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=codecitadel",
    "-p",
    `127.0.0.1:${input.hostPort}:5432`,
    input.image,
  ]);

  const deadline = Date.now() + (input.readyTimeoutMs ?? 90_000);
  for (;;) {
    try {
      await docker(["exec", input.name, "pg_isready", "-U", "postgres", "-d", "codecitadel"], 15_000);
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new DockerError(
          `The database container ${input.name} did not become ready: ${(error as Error).message}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  const serverVersion = await docker(
    ["exec", input.name, "psql", "-U", "postgres", "-d", "codecitadel", "-tAc", "select version()"],
    20_000,
  );
  return { name: input.name, serverVersion };
}

/** Removes the container, tolerating one that has already gone. */
export async function removeContainer(name: string): Promise<void> {
  try {
    await docker(["rm", "-f", name], 30_000);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("No such container")) {
      return;
    }
    throw new DockerError(
      `The container ${name} is still running and could not be removed: ${message}. Remove it with \`docker rm -f ${name}\`.`,
    );
  }
}

/**
 * A host port nothing is listening on. Binding to zero and reading the port
 * back avoids racing an operator's own services; the port is then handed to
 * `docker run`, which is a separate process, so the usual small race remains
 * and is reported by `docker run` if it is ever lost.
 */
export async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new DockerError("Could not read a free port from the loopback interface.");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
