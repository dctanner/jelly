import { expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { once } from "node:events";
import {
  BrowserEgress,
  reserveControllerPort,
} from "../src/server/browser-egress";

class Wire {
  buffer = Buffer.alloc(0);
  closed = false;
  constructor(readonly socket: Socket) {
    socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
    });
  }
  async read(count: number) {
    const deadline = Date.now() + 3000;
    while (this.buffer.length < count) {
      if (this.closed || Date.now() > deadline)
        throw new Error("SOCKS fixture closed or timed out");
      await Bun.sleep(5);
    }
    const data = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return data;
  }
}
async function fixture() {
  const denied = new Set<number>();
  const proxy = new BrowserEgress((_host, port) => denied.has(port));
  const url = new URL(await proxy.listen((port) => denied.add(port)));
  const open = async () => {
    const wire = new Wire(connect(Number(url.port), "127.0.0.1"));
    await once(wire.socket, "connect");
    return wire;
  };
  return { proxy, denied, open, port: Number(url.port) };
}
const domain = (host: string, port: number, command = 1) =>
  Buffer.concat([
    Buffer.from([5, command, 0, 3, Buffer.byteLength(host)]),
    Buffer.from(host),
    Buffer.from([port >> 8, port & 255]),
  ]);
async function greet(wire: Wire) {
  wire.socket.write(Buffer.from([5, 1, 0]));
  expect([...(await wire.read(2))]).toEqual([5, 0]);
}
async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

test("SOCKS gate validates protocol/auth/commands/addresses and denies protected ports before DNS", async () => {
  const f = await fixture();
  try {
    const auth = await f.open();
    auth.socket.write(Buffer.from([5, 1, 2]));
    expect([...(await auth.read(2))]).toEqual([5, 255]);
    auth.socket.destroy();
    const version = await f.open();
    const closed = once(version.socket, "close");
    version.socket.write(Buffer.from([4, 1, 0]));
    await closed;
    for (const cmd of [2, 3]) {
      const wire = await f.open();
      await greet(wire);
      wire.socket.write(domain("localhost", 80, cmd));
      expect((await wire.read(10))[1]).toBe(7);
      wire.socket.destroy();
    }
    f.denied.add(41234);
    for (const host of ["localhost", "127.0.0.1", "other-host.invalid"]) {
      const wire = await f.open();
      await greet(wire);
      wire.socket.write(domain(host, 41234));
      expect((await wire.read(10))[1]).toBe(2);
      wire.socket.destroy();
    }
    for (const address of [
      Buffer.from([1, 127, 0, 0, 1]),
      Buffer.from([4, ...Array(15).fill(0), 1]),
    ]) {
      const wire = await f.open();
      await greet(wire);
      wire.socket.write(
        Buffer.concat([
          Buffer.from([5, 1, 0]),
          address,
          Buffer.from([41234 >> 8, 41234 & 255]),
        ]),
      );
      expect((await wire.read(10))[1]).toBe(2);
      wire.socket.destroy();
    }
    for (const host of ["bad/host", "bad\0host"]) {
      const wire = await f.open();
      await greet(wire);
      wire.socket.write(domain(host, 80));
      expect((await wire.read(10))[1]).toBe(8);
      wire.socket.destroy();
    }
    const self = await f.open();
    await greet(self);
    self.socket.write(domain("localhost", f.port));
    expect((await self.read(10))[1]).toBe(2);
    self.socket.destroy();
    const dns = await f.open();
    await greet(dns);
    dns.socket.write(domain("jelly-nonexistent-proxy-test.invalid", 80));
    expect((await dns.read(10))[1]).toBe(4);
    dns.socket.destroy();
  } finally {
    await f.proxy.close();
  }
});

test("fragmented SOCKS handshake forwards opaque bytes and revokes already connected destinations", async () => {
  const f = await fixture();
  const origin = createServer((socket) => socket.pipe(socket));
  const port = await listen(origin);
  const wire = await f.open();
  try {
    for (const byte of [5, 1, 0]) {
      wire.socket.write(Buffer.from([byte]));
      await Bun.sleep(5);
    }
    expect([...(await wire.read(2))]).toEqual([5, 0]);
    const command = domain("127.0.0.1", port);
    wire.socket.write(command.subarray(0, 6));
    await Bun.sleep(5);
    wire.socket.write(command.subarray(6));
    expect((await wire.read(10))[1]).toBe(0);
    const bytes = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256));
    wire.socket.write(bytes);
    expect(await wire.read(bytes.length)).toEqual(bytes);
    const closed = once(wire.socket, "close");
    f.denied.add(port);
    f.proxy.revoke(port);
    await closed;
    const next = await f.open();
    await greet(next);
    next.socket.write(domain("localhost", port));
    expect((await next.read(10))[1]).toBe(2);
    next.socket.destroy();
  } finally {
    wire.socket.destroy();
    await f.proxy.close();
    await close(origin);
  }
});

test("HTTP streaming, cancellation and shutdown preserve opaque transport without buffering", async () => {
  const f = await fixture();
  let cancelled = false;
  const origin = createServer((socket) => {
    socket.once("data", () =>
      socket.write(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\nfirst-event\n",
      ),
    );
    socket.on("close", () => {
      cancelled = true;
    });
  });
  const port = await listen(origin);
  const wire = await f.open();
  try {
    await greet(wire);
    wire.socket.write(domain("127.0.0.1", port));
    expect((await wire.read(10))[1]).toBe(0);
    wire.socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const expected =
      "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\nfirst-event\n";
    expect((await wire.read(expected.length)).toString()).toBe(expected);
    wire.socket.destroy();
    for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10);
    expect(cancelled).toBe(true);
    const incomplete = await f.open();
    const closed = once(incomplete.socket, "close");
    await f.proxy.close();
    await closed;
  } finally {
    wire.socket.destroy();
    await f.proxy.close();
    await close(origin);
  }
});

test("CDP port is registered before the reservation is released", async () => {
  let registered = 0;
  const port = await reserveControllerPort((value) => {
    registered = value;
  });
  expect(port).toBe(registered);
  expect(port).toBeGreaterThan(0);
});

test("egress policy errors fail closed and reserved ports are skipped", async () => {
  const proxy = new BrowserEgress(() => {
    throw new Error("private policy detail");
  });
  let selections = 0;
  const url = new URL(
    await proxy.listen(
      () => {},
      () => ++selections === 1,
    ),
  );
  const wire = new Wire(connect(Number(url.port), "127.0.0.1"));
  try {
    await once(wire.socket, "connect");
    await greet(wire);
    wire.socket.write(domain("9999999999", 80));
    expect((await wire.read(10))[1]).toBe(2);
    expect(selections).toBe(2);
    const closing = proxy.close();
    expect(proxy.close()).toBe(closing);
    await closing;
    await proxy.close();
  } finally {
    wire.socket.destroy();
    await proxy.close();
  }
});
