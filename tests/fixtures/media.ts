/** A small valid PCM WAV, generated without codec or filesystem dependencies. */
export function wavFixture(seconds = 2) {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / rate) * 500), 44 + i * 2);
  return bytes;
}

/** Container header for metadata/HTTP tests; browser tests generate a real video. */
export function mp4Header() {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(24, 0); bytes.write("ftypisom", 4);
  bytes.write("isommp42", 16);
  return bytes;
}
