import {
  createServer,
  connect,
  isIP,
  type Server,
  type Socket,
} from "node:net";

export async function tailscaleNetwork(port: number) {
  const command = Bun.spawn(["tailscale", "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  if (code) throw new Error(`Cannot read Tailscale status: ${stderr.trim()}`);
  const status = JSON.parse(stdout) as {
    BackendState: string;
    TailscaleIPs?: string[];
    Self?: { DNSName?: string; HostName?: string };
  };
  const addresses = (status.TailscaleIPs ?? []).filter((ip) => isIP(ip));
  if (status.BackendState !== "Running" || !addresses.length)
    throw new Error(
      "Connect this computer to Tailscale before starting dev:tailscale.",
    );
  const names = [
    status.Self?.DNSName?.replace(/\.$/, ""),
    status.Self?.HostName,
  ].filter((name): name is string => !!name);
  const hosts = [
    ...new Set([
      ...names,
      ...addresses.map((ip) => (isIP(ip) === 6 ? `[${ip}]` : ip)),
    ]),
  ];
  return { addresses, origins: hosts.map((host) => `http://${host}:${port}`) };
}

/** Fixed loopback target; bind only Tailscale addresses, never LAN/wildcards.
 * TCP piping preserves streaming, HTTP upgrades and Vite's HMR WebSockets.
 */
export async function forwardTailnet(addresses: string[], port: number) {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  };
  try {
    for (const host of addresses) {
      const server = createServer((incoming) => {
        const upstream = connect({ host: "127.0.0.1", port });
        sockets.add(incoming);
        sockets.add(upstream);
        const dispose = () => {
          incoming.destroy();
          upstream.destroy();
          sockets.delete(incoming);
          sockets.delete(upstream);
        };
        incoming.on("error", dispose).on("close", dispose);
        upstream.on("error", dispose).on("close", dispose);
        incoming.setKeepAlive(true, 30000);
        upstream.setKeepAlive(true, 30000);
        incoming.pipe(upstream).pipe(incoming);
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port, ipv6Only: isIP(host) === 6 }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    }
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
