import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarDirector, REACTION_MS } from "./director";
import type { AvatarModel, SemanticState } from "./types";

function makeModel() {
  const model: AvatarModel = {
    load: vi.fn(), setVocalLevel: vi.fn(), playSemantic: vi.fn(), playReaction: vi.fn(),
    applyEmotion: vi.fn(), reset: vi.fn(), resetExpression: vi.fn(), destroy: vi.fn(),
  };
  return model;
}

describe("AvatarDirector channels", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["idle", "writing", "researching", "executing", "syncing", "error"] as SemanticState[])("changes %s motion while speaking without applying its expression", state => {
    const model = makeModel(), director = new AvatarDirector(model);
    director.setTalking(true); director.setSemantic(state);
    expect(model.playSemantic).toHaveBeenLastCalledWith(state, false);
    expect(model.resetExpression).toHaveBeenCalledTimes(1);
  });
  it("restores the current semantic expression when speaking ends", () => {
    const model = makeModel(), director = new AvatarDirector(model);
    director.setTalking(true); director.setSemantic("writing"); director.setTalking(false);
    expect(model.reset).toHaveBeenCalledTimes(1);
    expect(model.playSemantic).toHaveBeenLastCalledWith("writing", true);
  });
  it("keeps reaction latest-wins and restores the latest base", () => {
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const model = makeModel(), snapshots = vi.fn(), director = new AvatarDirector(model, snapshots);
    director.setSemantic("writing"); director.setReaction("blocked");
    vi.advanceTimersByTime(400); director.setSemantic("executing"); director.setReaction("interrupted");
    vi.advanceTimersByTime(REACTION_MS);
    expect(model.playReaction).toHaveBeenNthCalledWith(1, "blocked", REACTION_MS);
    expect(model.playReaction).toHaveBeenNthCalledWith(2, "interrupted", REACTION_MS);
    expect(model.playSemantic).toHaveBeenLastCalledWith("executing", true);
    expect(snapshots).toHaveBeenLastCalledWith({ semantic: "executing", speaking: false, reaction: null, emotion: "active" });
  });
  it("does not restore a semantic expression while talking", () => {
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const model = makeModel(), director = new AvatarDirector(model);
    director.setTalking(true); director.setReaction("blocked"); vi.advanceTimersByTime(REACTION_MS);
    expect(model.playSemantic).toHaveBeenLastCalledWith("idle", false);
  });
  it("stop clears every channel and invalidates reaction timers", () => {
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const model = makeModel(), changed = vi.fn(), director = new AvatarDirector(model, changed);
    director.setSemantic("error"); director.setTalking(true); director.setReaction("blocked"); director.setEmotion("curious"); director.stop();
    vi.advanceTimersByTime(REACTION_MS);
    expect(changed).toHaveBeenLastCalledWith({ semantic: "idle", speaking: false, reaction: null, emotion: "relaxed" });
    expect(model.playSemantic).toHaveBeenLastCalledWith("idle", true);
    expect(model.applyEmotion).toHaveBeenLastCalledWith("relaxed");
  });
});
