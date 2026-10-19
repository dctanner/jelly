import { useEffect, useRef, useState } from "react";

/** Shared noVNC connection policy, with lifecycle/consent owned by each panel. */
export function useVncViewer({
  enabled,
  interactive,
  revision,
  socketPath,
  requestTicket,
}: {
  enabled: boolean;
  interactive: boolean;
  revision: number;
  socketPath: string;
  requestTicket: () => Promise<string>;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const connection = useRef<import("@novnc/novnc/lib/rfb").default | null>(
    null,
  );
  const ticket = useRef(requestTicket);
  ticket.current = requestTicket;
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  useEffect(() => {
    if (!enabled || !screen.current) return;
    let dead = false,
      rfb: import("@novnc/novnc/lib/rfb").default | undefined;
    setConnected(false);
    setConnectionError("");
    void (async () => {
      try {
        const [{ default: RFB }, token] = await Promise.all([
          import("@novnc/novnc"),
          ticket.current(),
        ]);
        if (dead) return;
        const url = new URL(socketPath, window.location.href);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", token);
        rfb = new RFB(screen.current!, url.href);
        connection.current = rfb;
        rfb.viewOnly = !interactive;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.addEventListener("connect", () => {
          if (!dead) setConnected(true);
        });
        rfb.addEventListener("disconnect", () => {
          if (!dead) {
            setConnected(false);
            setConnectionError(
              "Desktop disconnected. Browser tools remain paused during human control. Reconnect explicitly or Return control.",
            );
          }
        });
        rfb.addEventListener("securityfailure", () => {
          if (!dead)
            setConnectionError(
              "Desktop connection refused. Reconnect explicitly.",
            );
        });
      } catch (e) {
        if (!dead) setConnectionError((e as Error).message);
      }
    })();
    return () => {
      dead = true;
      setConnected(false);
      if (connection.current === rfb) connection.current = null;
      rfb?.disconnect();
      screen.current?.replaceChildren();
    };
  }, [enabled, interactive, revision, socketPath]);
  return { screen, connection, connected, connectionError };
}
