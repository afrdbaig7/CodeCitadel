import { describe, expect, it } from "vitest";

import {
  buildSandboxedEnvironment,
  DEFAULT_SANDBOX_POLICY,
  validateSandboxArtifact,
} from "../src/index.js";

describe("execution sandbox policy & environment", () => {
  it("strips sensitive host credentials, cloud tokens, and Docker sockets", () => {
    const dirtyEnv = {
      PATH: "/usr/bin:/bin",
      NODE_ENV: "production",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      GOOGLE_APPLICATION_CREDENTIALS: "/keys/gcp.json",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DATABASE_URL: "postgres://admin:secret@db.internal:5432/codecitadel",
      GITHUB_TOKEN: "ghp_1234567890abcdef",
      MY_CUSTOM_SECRET: "topsecret",
    };

    const sanitized = buildSandboxedEnvironment(dirtyEnv);

    expect(sanitized["PATH"]).toBe("/usr/bin:/bin");
    expect(sanitized["NODE_ENV"]).toBe("production");
    expect(sanitized["CODECITADEL_SANDBOX"]).toBe("1");
    expect(sanitized["CODECITADEL_MANAGED"]).toBe("1");

    // All sensitive values must be stripped
    expect(sanitized["AWS_ACCESS_KEY_ID"]).toBeUndefined();
    expect(sanitized["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(sanitized["GOOGLE_APPLICATION_CREDENTIALS"]).toBeUndefined();
    expect(sanitized["DOCKER_HOST"]).toBeUndefined();
    expect(sanitized["DATABASE_URL"]).toBeUndefined();
    expect(sanitized["GITHUB_TOKEN"]).toBeUndefined();
    expect(sanitized["MY_CUSTOM_SECRET"]).toBeUndefined();
  });

  it("respects explicit safe allow list for authorized variables", () => {
    const dirtyEnv = {
      PATH: "/usr/bin",
      MY_CUSTOM_SECRET: "authorized_value",
      DATABASE_URL: "postgres://admin@db:5432",
    };

    const sanitized = buildSandboxedEnvironment(dirtyEnv, ["MY_CUSTOM_SECRET"]);
    expect(sanitized["MY_CUSTOM_SECRET"]).toBe("authorized_value");
    expect(sanitized["DATABASE_URL"]).toBeUndefined();
  });

  it("validates supervisor result channel artifacts with correct SHA-256", () => {
    const content = Buffer.from('{"status":"passed"}', "utf8");
    const artifact = validateSandboxArtifact("report.json", content);

    expect(artifact.name).toBe("report.json");
    expect(artifact.bytes).toEqual(content);
    expect(artifact.digest).toBe(
      "sha256:76f1805001bc4f155c8efa5651c57c4f1858af1f6786cbe4596214a4b64375a6",
    );
  });

  it("rejects illegal artifact names that could traverse paths", () => {
    const content = Buffer.from("data");
    expect(() => validateSandboxArtifact("../escape.txt", content)).toThrow(
      /Invalid sandbox artifact name/,
    );
    expect(() => validateSandboxArtifact("invalid name with spaces", content)).toThrow(
      /Invalid sandbox artifact name/,
    );
  });

  it("exposes default security sandbox policy settings", () => {
    expect(DEFAULT_SANDBOX_POLICY.runAsNonRoot).toBe(true);
    expect(DEFAULT_SANDBOX_POLICY.networkAccess).toBe("denied");
    expect(DEFAULT_SANDBOX_POLICY.disallowDockerSocket).toBe(true);
    expect(DEFAULT_SANDBOX_POLICY.dropCapabilities).toContain("CAP_SYS_ADMIN");
  });
});
