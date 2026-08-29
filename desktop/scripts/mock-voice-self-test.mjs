import assert from "node:assert/strict";
import { createSession, waveWav } from "./mock-speak-protocol.mjs";

function run(mode, message) {
  return new Promise(resolve => { const frames = [], receive = createSession(mode, value => { frames.push(value); if ((typeof value === "string" && JSON.parse(value).type === "end") || mode === "fallback") resolve({ frames, closed: false }); }, () => resolve({ frames, closed: true }), 0); receive(message); });
}
function runAuto() { return new Promise(resolve => { const frames = []; createSession("auto", value => { frames.push(value); if (typeof value === "string" && JSON.parse(value).type === "end") resolve(frames); }, () => {}, 0); }); }

const stream = await run("stream", { done: true });
assert.equal(JSON.parse(stream.frames[0]).type, "start"); assert.equal(JSON.parse(stream.frames.at(-1)).type, "end");
const pcm = Buffer.concat(stream.frames.filter(Buffer.isBuffer)); let sum = 0; for (let i = 0; i < pcm.length; i += 2) { const value = pcm.readInt16LE(i) / 32768; sum += value * value; }
const peakRms = Math.sqrt(sum / (pcm.length / 2)); assert.ok(peakRms > 0.2);
const fallback = await run("fallback", { done: true }); assert.equal(JSON.parse(fallback.frames[0]).type, "fallback");
const stopped = await run("stream", { stop: true }); assert.equal(JSON.parse(stopped.frames[0]).type, "end");
const disconnected = await run("disconnect", { done: true }); assert.equal(disconnected.closed, true);
const wav = waveWav(); assert.equal(wav.subarray(0, 4).toString(), "RIFF");
const auto = await runAuto(); assert.equal(JSON.parse(auto[0]).type, "start"); assert.equal(JSON.parse(auto.at(-1)).type, "end"); assert.equal(Buffer.concat(auto.filter(Buffer.isBuffer)).length, (wav.length - 44) * 4);
console.log(JSON.stringify({ event: "mock-voice-self-test", streamFrames: stream.frames.length - 2, autoFrames: auto.length - 2, autoSeconds: 2, peakRms, fallback: true, stop: true, disconnect: true, wavBytes: wav.length }));
