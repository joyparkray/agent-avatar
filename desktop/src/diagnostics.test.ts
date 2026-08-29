import { describe, expect, it, vi } from "vitest";
import { installGlobalDiagnostics } from "./diagnostics";

describe("global diagnostics", () => {
  it("forwards console errors with stacks and rate-limits duplicate messages", () => {
    const target = new EventTarget(), output = { error: vi.fn(), warn: vi.fn() }, log = vi.fn(); let time = 1000;
    const restore = installGlobalDiagnostics(log, target, output, () => time);
    const error = new Error("render failed"); output.error(error); output.error(error);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "console:error", message: "render failed", stack: expect.stringContaining("render failed") }));
    time += 1000; output.error(error); expect(log).toHaveBeenCalledTimes(2);
    restore();
  });

  it("forwards warnings and global errors", () => {
    const target = new EventTarget(), output = { error: vi.fn(), warn: vi.fn() }, log = vi.fn();
    const restore = installGlobalDiagnostics(log, target, output);
    const errorEvent = Object.assign(new Event("error"), { message: "GL failure", error: new Error("GL failure") });
    output.warn("texture warning"); target.dispatchEvent(errorEvent);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "console:warn", message: "texture warning" }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "window:error", message: "GL failure" }));
    restore();
  });
});
