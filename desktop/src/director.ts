import { emotionForSemantic } from "./semantic";
import type { AvatarDirector as Contract, AvatarModel, AvatarState, EmotionCue, Reaction, SemanticState } from "./types";

export const REACTION_MS = 700;

export class AvatarDirector implements Contract {
  private semantic: SemanticState = "idle"; private talking = false; private reaction: Reaction | null = null;
  private explicitEmotion: EmotionCue | null = null; private reactionTimer?: number; private reactionGeneration = 0;
  constructor(private readonly model: AvatarModel, private readonly changed: (state: Readonly<AvatarState>) => void = () => {}) {}
  setSemantic(state: SemanticState): void {
    this.semantic = state;
    this.model.playSemantic(state, !this.talking && !this.reaction);
    if (!this.explicitEmotion) this.model.applyEmotion(emotionForSemantic(state));
    this.notify();
  }
  setTalking(on: boolean): void {
    if (this.talking === on) return;
    this.talking = on;
    if (on) this.model.resetExpression();
    else { this.model.reset(); if (!this.reaction) this.model.playSemantic(this.semantic, true); }
    this.notify();
  }
  setReaction(reaction: Reaction): void {
    this.cancelReaction();
    this.reaction = reaction;
    const generation = ++this.reactionGeneration;
    this.model.playReaction(reaction, REACTION_MS);
    this.reactionTimer = window.setTimeout(() => {
      if (generation !== this.reactionGeneration) return;
      this.reactionTimer = undefined; this.reaction = null;
      this.model.playSemantic(this.semantic, !this.talking);
      this.notify();
    }, REACTION_MS);
    this.notify();
  }
  setEmotion(cue: EmotionCue | null): void { this.explicitEmotion = cue; this.model.applyEmotion(cue ?? emotionForSemantic(this.semantic)); this.notify(); }
  stop(): void {
    this.cancelReaction(); this.reactionGeneration++; this.semantic = "idle"; this.talking = false; this.reaction = null; this.explicitEmotion = null;
    this.model.reset(); this.model.playSemantic("idle", true); this.model.applyEmotion("relaxed"); this.notify();
  }
  private cancelReaction(): void { if (this.reactionTimer !== undefined) clearTimeout(this.reactionTimer); this.reactionTimer = undefined; }
  private notify(): void { this.changed({ semantic: this.semantic, speaking: this.talking, reaction: this.reaction, emotion: this.explicitEmotion ?? emotionForSemantic(this.semantic) }); }
}
