import { describe, expect, it } from "vitest";
import { restoreClearColor } from "./gl-state";

describe("restoreClearColor", () => {
  it("resets the clear colour Cubism left behind, keeping Pixi's cached state valid", () => {
    const calls: number[][] = [];
    restoreClearColor({ gl: { clearColor: (...args: number[]) => calls.push(args) } });
    expect(calls).toEqual([[0, 0, 0, 0]]);
  });
  it("tolerates renderers without a GL context", () => {
    expect(() => restoreClearColor({})).not.toThrow();
    expect(() => restoreClearColor(null)).not.toThrow();
  });
});
