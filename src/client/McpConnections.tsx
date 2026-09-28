import { useEffect, useState } from "react";
import { control } from "./api";
import type { McpStatus } from "../shared/types";

export function McpConnections() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    setBusy(true);
    control<McpStatus>("/mcps/status")
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active)
          setStatus({ servers: [], error: "Could not check MCP connections." });
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return (
    <fieldset className="account-connections">
      <legend>MCP connections</legend>
      <p className="subtle">
        Available to all your agents and projects. Ask Jelly to connect or
        manage an MCP server.
      </p>
      {status?.error ? (
        <p role="alert" className="error-text">
          {status.error}
        </p>
      ) : status?.servers.length === 0 ? (
        <p className="subtle">No MCP servers connected.</p>
      ) : (
        status?.servers.map((server) => (
          <div className="account-block" key={server.name}>
            <div className="account-title">
              <strong>{server.name}</strong>
            </div>
            <p className="subtle">
              {server.status === "connected"
                ? `Connected · ${server.toolCount} tools`
                : server.status === "needs_auth"
                  ? "Sign-in required"
                  : "Unavailable"}
            </p>
          </div>
        ))
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => setRevision((r) => r + 1)}
      >
        {busy ? "Checking MCP connections…" : "Refresh MCP connections"}
      </button>
    </fieldset>
  );
}
