import { connect, createServer, isIP, type Socket } from "node:net";

/** Mandatory TCP-only SOCKS5 egress for managed Chromium. Unlike context.route,
 * this gate applies to every destination, including redirect hops, workers and
 * restored/new tabs. HTTP, TLS, WebSockets and streaming bodies remain opaque;
 * Chromium still verifies TLS certificates end-to-end. No DIRECT fallback. */
export class BrowserEgress {
  private sockets = new Set<Socket>();
  private closing?: Promise<void>;
  private destinations = new Map<Socket, number>();
  private server = createServer((client) => this.accept(client));
  constructor(private denied: (host: string, port: number) => boolean) {}

  private blocked(host: string, port: number) {
    // Unusual SOCKS hostnames must not turn a policy parsing error into either
    // an unhandled server exception or an allowed outbound connection.
    try {
      return this.denied(host, port);
    } catch {
      return true;
    }
  }
  private track(socket: Socket, port?: number) {
    this.sockets.add(socket);
    if (port !== undefined) this.destinations.set(socket, port);
    socket.on("error", () => {});
    socket.once("close", () => {
      this.sockets.delete(socket);
      this.destinations.delete(socket);
    });
  }
  private accept(client: Socket) {
    this.track(client);
    let greeting = true,
      buffer = Buffer.alloc(0),
      finished = false;
    const timer = setTimeout(() => client.destroy(), 10000);
    const fail = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.off("data", receive);
      buffer = Buffer.alloc(0);
      client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]), () =>
        client.destroy(),
      );
    };
    client.once("close", () => clearTimeout(timer));
    const receive = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (greeting) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] === 0) {
          client.destroy();
          return;
        }
        const end = 2 + buffer[1]!;
        if (buffer.length < end) return;
        if (!buffer.subarray(2, end).includes(0)) {
          clearTimeout(timer);
          client.off("data", receive);
          client.end(Buffer.from([5, 255]), () => client.destroy());
          return;
        }
        client.write(Buffer.from([5, 0]));
        buffer = buffer.subarray(end);
        greeting = false;
      }
      if (buffer.length < 4) return;
      if (buffer[0] !== 5 || buffer[2] !== 0) {
        fail(1);
        return;
      }
      if (buffer[1] !== 1) {
        fail(7);
        return;
      } // CONNECT only; no UDP/BIND.
      const type = buffer[3];
      if (![1, 3, 4].includes(type!)) {
        fail(8);
        return;
      }
      if (type === 3 && buffer.length < 5) return;
      const length = type === 1 ? 4 : type === 4 ? 16 : buffer[4]!;
      const offset = type === 3 ? 5 : 4;
      const end = offset + length + 2;
      // SOCKS address lengths are bounded (at most 255 bytes), not user sizes.
      if (!length) {
        fail(8);
        return;
      }
      if (buffer.length < end) return;
      const address = buffer.subarray(offset, offset + length);
      const host =
        type === 1
          ? [...address].join(".")
          : type === 4
            ? Array.from({ length: 8 }, (_, i) =>
                address.readUInt16BE(i * 2).toString(16),
              ).join(":")
            : address.toString("ascii");
      const port = buffer.readUInt16BE(offset + length);
      if (
        !port ||
        (type === 3 &&
          ((!/^[a-zA-Z0-9._-]+$/.test(host) && isIP(host) !== 6) ||
            address.some((byte) => byte > 127)))
      ) {
        fail(8);
        return;
      }
      if (this.blocked(host, port)) {
        fail(2);
        return;
      }
      client.off("data", receive);
      client.pause();
      this.destinations.set(client, port);
      const head = buffer.subarray(end);
      buffer = Buffer.alloc(0);
      const upstream = connect({ host, port });
      this.track(upstream, port);
      // Covers DNS/connect stalls without imposing an idle timeout on streams.
      upstream.setTimeout(10000, () => {
        fail(4);
        upstream.destroy();
      });
      let connected = false;
      upstream.once("connect", () => {
        if (finished || this.blocked(host, port)) {
          fail(2);
          upstream.destroy();
          return;
        }
        connected = true;
        finished = true;
        clearTimeout(timer);
        upstream.setTimeout(0);
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => {
        if (!finished) fail(4);
        else client.destroy();
      });
      upstream.on("close", () => {
        if (connected) client.destroy();
      });
      client.on("close", () => upstream.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", receive);
  }
  /** Registration revokes connections established before a port was protected. */
  revoke(port: number) {
    for (const [socket, destination] of this.destinations)
      if (destination === port) socket.destroy();
  }
  async listen(
    register: (port: number) => void,
    reserved: (port: number) => boolean = () => false,
  ) {
    const port = await bindUnreserved(this.server, reserved);
    register(port);
    return `socks5://127.0.0.1:${port}`;
  }
  close() {
    if (this.closing) return this.closing;
    const closed = (this.closing = new Promise<void>((resolve) =>
      this.server.close(() => resolve()),
    ));
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.destinations.clear();
    return closed;
  }
}

/** Register CDP before Chromium can listen, then release the reservation.
 * Chromium must bind this exact port; there is no random-port fallback. */
export async function reserveControllerPort(
  register: (port: number) => void,
  reserved: (port: number) => boolean = () => false,
) {
  const reservation = createServer();
  const port = await bindUnreserved(reservation, reserved);
  try {
    register(port);
  } finally {
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
  }
  return port;
}

// A port between reservation and child bind is already protected, though the
// OS still considers it free. Do not let simultaneous Jelly launches claim it.
async function bindUnreserved(
  server: ReturnType<typeof createServer>,
  reserved: (port: number) => boolean,
) {
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const port = (server.address() as { port: number }).port;
    if (!reserved(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error("Could not reserve a private browser control port.");
}
