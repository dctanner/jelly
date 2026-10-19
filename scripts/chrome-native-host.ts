import { connect } from "node:net";
import { localX11Desktop, nativeChromeDesktop } from "../src/server/chrome-desktop";
import { ownedProcess } from "../src/server/owned-chrome-desktop";
import { ChromeWriter } from "../src/server/chrome-writer";
import { readFileSync, lstatSync } from "node:fs";
import {
  ChromeFrames,
  chromeFrame,
  CHROME_PROTOCOL,
} from "../src/shared/chrome-protocol";
// stdout is exclusively framed native messaging. Never log messages or grants.
try {
  const path = process.argv[2]!;
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error();
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (process.argv[3] !== `chrome-extension://${config.extensionId}/`)
    throw new Error();
  const socket = connect(config.socket);
  const incoming = new ChromeFrames(),
    outgoing = new ChromeFrames();
  let hello = false;
  const stop = () => {
    socket.destroy();
    process.exit(0);
  };
  const toSocket = new ChromeWriter(
    socket,
    stop,
    () => process.stdin.pause(),
    () => process.stdin.resume(),
  );
  const toStdout = new ChromeWriter(
    process.stdout,
    stop,
    () => socket.pause(),
    () => socket.resume(),
  );
  process.stdout.on("error", stop);
  socket.on("error", stop);
  socket.on("close", stop);
  process.stdin.on("end", stop);
  process.stdin.on("data", (data) => {
    try {
      for (const value of incoming.push(
        typeof data === "string" ? Buffer.from(data) : data,
      )) {
        const v = value as Record<string, unknown>;
        if (!hello) {
          if (v.type !== "hello" || v.version !== CHROME_PROTOCOL)
            throw new Error();
          hello = true;
          toSocket.write(
            chromeFrame({
              ...v,
              extensionId: config.extensionId,
              instance: config.instance,
              grant: config.grant,
              desktop: nativeChromeDesktop(),
              // Only the private owned launcher record can authorize this exact
              // direct Chrome parent; legacy/unowned X11 attestation is unchanged.
              ownedParent: (() => { try { return ownedProcess(process.ppid); } catch { return null; } })(),
              ownedDesktop: localX11Desktop(process.env),
            }),
          );
        } else toSocket.write(chromeFrame(value));
      }
    } catch {
      stop();
    }
  });
  socket.on("data", (data) => {
    try {
      for (const value of outgoing.push(
        typeof data === "string" ? Buffer.from(data) : data,
      ))
        toStdout.write(chromeFrame(value));
    } catch {
      stop();
    }
  });
} catch {
  process.exit(1);
}
