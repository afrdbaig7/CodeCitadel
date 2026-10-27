import { expect, it } from "vitest";

import { writeMarker } from "./writes";

it("can write in its working directory", () => {
  expect(writeMarker()).toBe(true);
});
