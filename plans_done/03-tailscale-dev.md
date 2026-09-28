# Tailscale development access delivered

The dev server can be reached over HTTP using this computer's Tailscale DNS name or IPv4/IPv6 address on port 5173. `bun run dev:tailscale`, or `JELLY_TAILSCALE=1` with `bun run dev`, discovers and configures those addresses automatically. Loopback access remains available.

A fixed TCP forwarder preserves Vite hot reload, SSE and browser desktop upgrades while listening only on Tailscale addresses. Exact host/origin allowlists and managed-browser control-origin protection include the external addresses. Request-ID generation supports HTTP browsers. No Tailscale Serve configuration, public listener or administrator authentication is required.

Implementation: [dev supervisor](../scripts/dev.ts), [tailnet transport](../scripts/tailscale.ts), [origin parsing](../src/shared/network.ts), [Vite](../vite.config.ts), [API](../src/server/app.ts) and [browser request IDs](../src/client/request-id.ts).

Type checking passed. The page and health endpoint responded through loopback, the Tailscale IPv4 address and MagicDNS name from this host. Cross-device UI checks remain manual. For setup, see the [README](../README.md#security-and-local-data).

This is development transport access. Saved instance connections, instance switching and application-level remote authentication remain in [Phase 3](../plans/03-remote-instances.md).
