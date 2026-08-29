export function waveWav() {
  const rate = 24000, n = rate / 2, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.sin(i * 440 * 2 * Math.PI / rate) * 12000, 44 + i * 2);
  return b;
}

export function createSession(mode, send, close, intervalMs = 50) {
  const stream = (repeats = 1) => {
    send(JSON.stringify({ type: "start", sample_rate: 24000, channels: 1 }));
    const pcm = Buffer.concat(Array.from({ length: repeats }, () => waveWav().subarray(44))); let offset = 0;
    const pump = () => {
      if (offset >= pcm.length) return send(JSON.stringify({ type: "end" }));
      send(pcm.subarray(offset, offset + 2400)); offset += 2400;
      if (mode === "disconnect" && offset >= 4800) return close();
      setTimeout(pump, intervalMs);
    };
    pump();
  };
  if (mode === "auto") setTimeout(() => stream(4), 0);
  return raw => {
    const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (msg.done) {
      if (mode === "fallback") return send(JSON.stringify({ type: "fallback" }));
      stream();
    }
    if (msg.stop) send(JSON.stringify({ type: "end" }));
  };
}
