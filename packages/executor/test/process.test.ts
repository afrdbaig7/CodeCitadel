import { afterEach, describe, expect, it } from "vitest";

import { buildEnvironment, EnvironmentError, MAX_PASSTHROUGH_ENV } from "../src/index.js";

const SECRET = "CODECITADEL_TEST_FORWARDED";
const NOT_SET = "CODECITADEL_TEST_NEVER_SET";

afterEach(() => {
  delete process.env[SECRET];
  delete process.env[NOT_SET];
});

describe("buildEnvironment", () => {
  it("does not inherit arbitrary variables from this process", () => {
    process.env[SECRET] = "s3cret-value";

    const environment = buildEnvironment();

    expect(environment.env[SECRET]).toBeUndefined();
    expect(environment.env.NO_COLOR).toBe("1");
    expect(environment.env.PATH).toBe(process.env.PATH);
    expect(environment.forwarded).toEqual([]);
    expect(environment.missing).toEqual([]);
  });

  it("forwards a variable the caller names, and reports the name", () => {
    process.env[SECRET] = "postgres://demo";

    const environment = buildEnvironment([SECRET]);

    expect(environment.env[SECRET]).toBe("postgres://demo");
    expect(environment.forwarded).toEqual([SECRET]);
  });

  it("reports a requested variable that is not set instead of inventing one", () => {
    const environment = buildEnvironment([NOT_SET]);

    expect(environment.env[NOT_SET]).toBeUndefined();
    expect(environment.forwarded).toEqual([]);
    expect(environment.missing).toEqual([NOT_SET]);
  });

  it("counts a repeated name once", () => {
    process.env[SECRET] = "value";

    const environment = buildEnvironment([SECRET, SECRET]);

    expect(environment.forwarded).toEqual([SECRET]);
  });

  it("refuses a name that is not a portable variable name", () => {
    expect(() => buildEnvironment(["BAD-NAME"])).toThrow(EnvironmentError);
    expect(() => buildEnvironment(["WITH=EQUALS"])).toThrow(/not a valid environment variable name/);
    expect(() => buildEnvironment([""])).toThrow(EnvironmentError);
  });

  it("refuses to treat an always-forwarded variable as opt-in", () => {
    expect(() => buildEnvironment(["PATH"])).toThrow(/always forwarded/);
  });

  it(`refuses more than ${MAX_PASSTHROUGH_ENV} names`, () => {
    const names = Array.from({ length: MAX_PASSTHROUGH_ENV + 1 }, (_, index) => `DEMO_${index}`);

    expect(() => buildEnvironment(names)).toThrow(EnvironmentError);
  });

  it("does not put a value into the error message", () => {
    process.env[SECRET] = "s3cret-value";

    try {
      buildEnvironment([`${SECRET}-BAD`]);
      throw new Error("expected buildEnvironment to refuse the name");
    } catch (error) {
      expect((error as Error).message).not.toContain("s3cret-value");
    }
  });
});
