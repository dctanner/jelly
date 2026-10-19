import { strict as assert } from "node:assert";
import { connect, createServer, getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, type TcpNetConnectOpts } from "node:net";
import { connect as connectTls } from "node:tls";

// Start with the vulnerable default even if the invoking environment changed it.
setDefaultAutoSelectFamily(true);
await import("../../src/server/app");
assert.equal(getDefaultAutoSelectFamily(), false);

let errors = 0;
const options: TcpNetConnectOpts = {
  host: "unroutable.invalid",
  port: 443,
  // IPv6 multicast cannot be a TCP peer. No DNS or external service is used.
  // The old default walks both addresses and arms a timer on a null handle.
  lookup(_host, options, callback) {
    if (options.all) {
      callback(null, [
        { address: "ff02::1", family: 6 },
        { address: "ff02::2", family: 6 },
      ]);
    } else {
      callback(null, "ff02::1", 6);
    }
  },
};
const failed = process.argv[2] === "tls" ? connectTls(options) : connect(options);
failed.on("error", () => errors++);
failed.on("connect", () => {
  throw new Error("Unexpected multicast connection");
});

// Stay alive past Bun's 250ms attempt timer; receiving 'error' alone does not
// prove safety because the unpatched runtime crashes *after* delivering it.
await Bun.sleep(750);
failed.destroy();
assert.equal(errors, 1);

// Successful TCP connections must still work after the failed one.
const server = createServer(socket => socket.end("ok"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  const result = await new Promise<string>((resolve, reject) => {
    let data = "";
    const client = connect({ host: "127.0.0.1", port: address.port });
    client.on("data", chunk => { data += chunk; });
    client.on("error", reject);
    client.on("end", () => resolve(data));
  });
  assert.equal(result, "ok");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log("Handled connect failure; process survived; loopback connection passed.");
