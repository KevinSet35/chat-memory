import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

describe("chat-memory", () => {
  it("should export a VERSION string", () => {
    expect(VERSION).toBe("1.0.0");
  });
});
