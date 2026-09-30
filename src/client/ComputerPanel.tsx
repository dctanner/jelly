import { ChatFormCard, ChatFormActions } from "./ChatFormCard";
import { Modal } from "./Modal";
import { RemoteClipboard } from "./RemoteClipboard";
import { useEffect, useRef, useState } from "react";
import { X, Monitor, RotateCw } from "lucide-react";
import type { ComputerState } from "../shared/types";
import { api, control } from "./api";
export function ComputerPanel(props: { agentId: string; onClose: () => void; onChange: () => void }) {
  return <SessionComputerPanel key={props.agentId} {...props} />;
}
function SessionComputerPanel({
  agentId,
  onClose,
  onChange,
}: {
  agentId: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const scoped = (path: string) => `${path}?agentId=${encodeURIComponent(agentId)}`;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const screen = useRef<HTMLDivElement>(null);
  const connection = useRef<import("@novnc/novnc/lib/rfb").default | null>(null);
  const [state, setState] = useState<ComputerState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [connected, setConnected] = useState(false),
    [confirmRecovery, setConfirmRecovery] = useState(false);
  useEffect(() => {
    let dead = false;
    void control<ComputerState>(scoped("/computer/start"))
      .then((s) => {
        if (!dead) setState(s);
      })
      .catch((e) => {
        if (!dead) setError(e.message);
      });
    const timer = setInterval(() => {
      void api<ComputerState>(scoped("/computer"))
        .then((s) => {
          if (!dead) setState(s);
        })
        .catch(() => {});
    }, 1500);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, []);
  const ready = state?.status === "ready",
    owned = state?.owned ?? false,
    privateScreen = state?.control === "human" && !owned;
  useEffect(() => {
    if (!ready || privateScreen || !screen.current) return;
    let dead = false,
      rfb: import("@novnc/novnc/lib/rfb").default | undefined;
    setConnected(false);
    setError("");
    void (async () => {
      try {
        const [{ default: RFB }, { ticket }] = await Promise.all([
          import("@novnc/novnc"),
          control<{ ticket: string }>(scoped("/computer/ticket"), {
            mode: owned ? "control" : "view",
          }),
        ]);
        if (dead) return;
        const url = new URL(scoped("/api/computer/socket"), window.location.href);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket);
        rfb = new RFB(screen.current!, url.href);
        connection.current = rfb;
        rfb.viewOnly = !owned;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.addEventListener("connect", () => {
          if (!dead) setConnected(true);
        });
        rfb.addEventListener("disconnect", () => {
          if (!dead) setConnected(false);
        });
        rfb.addEventListener("securityfailure", () => {
          if (!dead)
            setError("Desktop connection was refused. Reconnect to try again.");
        });
      } catch (e) {
        if (!dead) setError((e as Error).message);
      }
    })();
    return () => {
      dead = true;
      if (connection.current === rfb) connection.current = null;
      rfb?.disconnect();
      screen.current?.replaceChildren();
    };
  }, [ready, owned, privateScreen, revision]);
  async function action(name: "take" | "release" | "close" | "recover") {
    setBusy(true);
    setError("");
    try {
      const next = await control<ComputerState>(scoped(`/computer/${name}`),
        name === "recover" ? { confirm: "discard-private-desktop" } : {});
      if (!alive.current) return;
      setState(next);
      setConfirmRecovery(false);
      if (name === "recover") setRevision((v) => v + 1);
      onChange();
      if (name === "close") onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reconnect() {
    setError("");
    try {
      const next = await control<ComputerState>(scoped("/computer/start"));
      if (!alive.current) return;
      setState(next);
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="Agent computer" onClose={onClose} kind="panel" className="computer-panel">
      <div className="computer-toolbar">
        <span>
          {owned
            ? "You have control · Agent browser tools paused"
            : privateScreen
              ? "Private session · Take control to sign in"
              : connected
                ? "Viewing · Agent has control"
                : "Connecting to desktop…"}
        </span>
        <div>
          <button disabled={busy || state?.control === "human"} onClick={() => void action("close")}>Close browser session</button>
          {owned ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void action("release")}
            >
              Return to agent
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !ready}
              onClick={() => void action("take")}
            >
              Take control
            </button>
          )}
          <button
            aria-label="Reconnect desktop"
            className="icon"
            onClick={() => void reconnect()}
          >
            <RotateCw size={16} />
          </button>
        </div>
      </div>
      {owned && connected && (
        <RemoteClipboard agentId={agentId} disabled={busy} paste={() => {
          const rfb = connection.current;
          if (!rfb || rfb.viewOnly) throw new Error("Remote desktop disconnected. Reconnect before pasting.");
          rfb.focus({ preventScroll: true });
          rfb.sendKey(0xffe3, "ControlLeft", true);
          try { rfb.sendKey(0x76, "KeyV"); }
          finally { rfb.sendKey(0xffe3, "ControlLeft", false); }
        }} />
      )}
      {(error || state?.error) && (
        <p role="alert" className="error-text">
          {error || state?.error}
        </p>
      )}
      <div
        className="computer-screen"
        ref={screen}
        style={{ display: privateScreen ? "none" : undefined }}
      />
      {privateScreen && (
        <div className="computer-private">
          <Monitor size={32} />
          <p>
            The agent cannot see or interact with this browser during a private
            handoff.
          </p>
        </div>
      )}
      {privateScreen && (
        confirmRecovery ? (
          <ChatFormCard title="Reset private desktop?" icon={<RotateCw size={20} />}
            description="Use this if the controlling window or its session was lost. This disconnects it, closes all private tabs, and clears the remote clipboard. Website sign-ins are retained. You receive a blank desktop; agents stay paused until you return control.">
            <ChatFormActions>
              <button disabled={busy} onClick={() => setConfirmRecovery(false)}>Cancel</button>
              <button className="primary" disabled={busy} onClick={() => void action("recover")}>Discard private tabs and take control</button>
            </ChatFormActions>
          </ChatFormCard>
        ) : <button disabled={busy} onClick={() => setConfirmRecovery(true)}>Recover lost control…</button>
      )}
      <p className="subtle">
        {owned
          ? "Sign in directly in the browser. Closing this panel keeps you in control until you explicitly return it."
          : "Take control to use the browser. Website sessions stay on this Jelly computer."}
      </p>
    </Modal>
  );
}
