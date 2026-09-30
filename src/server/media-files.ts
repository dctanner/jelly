import { extname } from "node:path";

const extensions = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".weba",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".oga",
  ".ogv",
  ".opus",
  ".flac",
]);
export const isMediaName = (name: string) =>
  extensions.has(extname(name).toLowerCase());

/** Check container signatures as well as extensions; never serve arbitrary text as media. */
export function mediaType(
  bytes: Buffer,
  name: string,
): { kind: "audio" | "video"; mimeType: string } | null {
  const ext = extname(name).toLowerCase();
  if (!extensions.has(ext)) return null;
  const head = bytes.subarray(0, 4096);
  const ascii = head.toString("latin1");
  if (
    ext === ".wav" &&
    ascii.startsWith("RIFF") &&
    ascii.slice(8, 12) === "WAVE"
  )
    return { kind: "audio", mimeType: "audio/wav" };
  if (ext === ".flac" && ascii.startsWith("fLaC"))
    return { kind: "audio", mimeType: "audio/flac" };
  if (
    ext === ".mp3" &&
    ((ascii.startsWith("ID3") && bytes.length >= 10) ||
      (bytes.length >= 4 &&
        bytes[0] === 0xff &&
        (bytes[1]! & 0xe0) === 0xe0 &&
        (bytes[1]! & 0x18) !== 0x08 &&
        (bytes[1]! & 0x06) !== 0 &&
        (bytes[2]! & 0xf0) !== 0 &&
        (bytes[2]! & 0xf0) !== 0xf0 &&
        (bytes[2]! & 0x0c) !== 0x0c))
  )
    return { kind: "audio", mimeType: "audio/mpeg" };
  if (
    ext === ".aac" &&
    bytes.length >= 7 &&
    bytes[0] === 0xff &&
    (bytes[1]! & 0xf6) === 0xf0
  )
    return { kind: "audio", mimeType: "audio/aac" };
  if (
    [".ogg", ".oga", ".ogv", ".opus"].includes(ext) &&
    ascii.startsWith("OggS")
  ) {
    if (ascii.includes("theora"))
      return { kind: "video", mimeType: "video/ogg" };
    if (
      ascii.includes("vorbis") ||
      ascii.includes("OpusHead") ||
      ascii.includes("FLAC")
    )
      return { kind: "audio", mimeType: "audio/ogg" };
  }
  if (
    [".webm", ".weba"].includes(ext) &&
    head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    ascii.includes("webm")
  )
    return {
      kind: ext === ".weba" ? "audio" : "video",
      mimeType: ext === ".weba" ? "audio/webm" : "video/webm",
    };
  if ([".mp4", ".m4v", ".m4a", ".mov"].includes(ext)) {
    for (let offset = 0; offset + 12 <= head.length;) {
      const size = head.readUInt32BE(offset);
      if (size < 8) break;
      if (
        ascii.slice(offset + 4, offset + 8) === "ftyp" &&
        size >= 16 &&
        size <= bytes.length - offset
      ) {
        const brand = ascii.slice(offset + 8, offset + 12);
        if (["avif", "avis", "heic", "heix", "mif1", "msf1"].includes(brand))
          return null;
        return ext === ".m4a"
          ? { kind: "audio", mimeType: "audio/mp4" }
          : {
              kind: "video",
              mimeType: ext === ".mov" ? "video/quicktime" : "video/mp4",
            };
      }
      offset += size;
    }
  }
  return null;
}

/** One bounded byte range, as used by native media controls and Safari seeking. */
export function mediaResponse(
  request: Request,
  bytes: Buffer,
  headers: Headers,
): Response {
  const size = bytes.length;
  headers.set("Accept-Ranges", "bytes");
  let start = 0,
    end = size - 1,
    status = 200;
  const range = request.headers.get("range");
  // No validators are emitted: an If-Range request must receive the full representation.
  if (range && request.method !== "HEAD" && !request.headers.has("if-range")) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && (match[1] || match[2])) {
      if (!match[1]) {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) start = size;
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start >= size ||
        start > end
      ) {
        headers.set("Content-Range", `bytes */${size}`);
        headers.set("Content-Length", "0");
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    // Ignore malformed or multipart ranges and send 200, per HTTP range semantics.
  }
  headers.set("Content-Length", String(end - start + 1));
  return new Response(
    request.method === "HEAD"
      ? null
      : new Uint8Array(
          bytes.buffer as ArrayBuffer,
          bytes.byteOffset + start,
          end - start + 1,
        ),
    { status, headers },
  );
}
