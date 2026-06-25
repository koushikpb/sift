import { describe, it, expect } from "vitest";
import { hello } from "../src/index.js";

describe("toolchain smoke", () => {
  it("imports from src", () => {
    expect(hello()).toBe("sift-core");
  });
});
