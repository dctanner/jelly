import { useEffect, useRef, useState } from "react";
import { Info, Monitor } from "lucide-react";
import { api, control } from "./api";
import { Modal } from "./Modal";
import { ChatFormActions, ChatFormCard } from "./ChatFormCard";
import { useVncViewer } from "./useVncViewer";
import { ComputerClipboard } from "./ComputerClipboard";
import { ComputerViewport } from "./ComputerViewport";
import { ComputerKeyboard } from "./ComputerKeyboard";
import type { ChromeStatus } from "./ChromeConnection";
import type { ChromeShareState } from "../shared/chrome-share";

export function ComputerControlPanel({
  agentId,
  onClose,
  onChange,
}: {
  agentId?: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const [state, setState] = useState<ChromeShareState | null>(null);
  const [chrome, setChrome] = useState<ChromeStatus | null>(null);
  const [useInstalled, setUseInstalled] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const lastState = useRef(state),
    doneSent = useRef(false);
  lastState.current = state;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0),
    [viewer, setViewer] = useState(true);
  const alive = useRef(true),
    controlling = useRef(false),
    request = useRef(0);
  const selected = chrome?.task?.profile ?? chrome?.selectedProfile;
  const profile = chrome?.profiles.find((p) => p.id === selected);
  useEffect(() => { setUseInstalled(false); }, [agentId, selected]);
  async function load() {
    if (controlling.current) return;
    const id = ++request.current;
    try {
      await api("/control-session");
      const [next, status] = await Promise.all([
        api<ChromeShareState>("/chrome/share"),
        api<ChromeStatus>(
          `/chrome?agentId=${encodeURIComponent(agentId ?? "")}`,
        ),
      ]);
      if (alive.current && id === request.current) {
        setState(next);
        setChrome(status);
      }
    } catch (e) {
      if (alive.current && id === request.current) {
        setError((e as Error).message);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      alive.current = false;
      ++request.current;
      clearInterval(timer);
      const owned = lastState.current;
      // Navigation can unmount the panel without Modal's close path. Bind the
      // best-effort Done to this viewer generation, never a later share.
      if (owned?.owned && !doneSent.current)
        void control("/chrome/share/release", {
          generation: owned.generation,
          controlId: owned.controlId,
          cleanupOnly: owned.status === "failed",
        }).catch(() => {}); // Server retains failed cleanup for the next visit.
    };
  }, [agentId]);
  const { screen, connection, connected, connectionError } = useVncViewer({
    enabled: viewer && state?.status === "sharing" && state.owned,
    interactive: true,
    revision,
    socketPath: "/api/chrome/share/socket",
    requestTicket: async () => {
      const displayed = lastState.current;
      const current = await api<ChromeShareState>("/chrome/share");
      if (!displayed?.owned || !current.owned || current.controlId !== displayed.controlId)
        throw new Error("Computer control changed. Reopen the panel to use the current viewer.");
      const next = await control<{ ticket: string; generation: number }>(
        "/chrome/share/ticket",
        { generation: current.generation },
      );
      if (alive.current && !controlling.current) {
        ++request.current;
        setState((s) =>
          s?.owned && s.controlId === displayed.controlId && s.generation <= next.generation
            ? { ...s, generation: next.generation }
            : s,
        );
      }
      return next.ticket;
    },
  });
  // Never fall back from a pinned/configured computer to a different desktop.
  const ownedTarget = (!selected || (useInstalled && !chrome?.task)) && !!state?.ownedDesktopAvailable;
  async function take() {
    if (
      controlling.current ||
      (ownedTarget ? !state?.ownedDesktopAvailable : !profile?.desktopAvailable)
    )
      return;
    controlling.current = true;
    ++request.current;
    setBusy(true);
    setError("");
    try {
      const next = await control<ChromeShareState>(
        !ownedTarget ? "/chrome/share/take" : "/chrome/share/take-owned",
        !ownedTarget && profile
          ? {
              agentId,
              profile: profile.id,
              profileGeneration: profile.generation,
            }
          : { agentId },
      );
      if (alive.current) {
        doneSent.current = false;
        setState(next);
        setViewer(true);
        setRevision((n) => n + 1);
        onChange();
      } else if (next.owned) {
        void control("/chrome/share/release", {
          generation: next.generation,
          controlId: next.controlId,
        }).catch(() => {});
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      controlling.current = false;
      if (alive.current) {
        setBusy(false);
        void load();
      }
    }
  }
  async function reconnect() {
    if (controlling.current || !state?.owned) return;
    controlling.current = true;
    ++request.current;
    setBusy(true);
    setError("");
    try {
      const next = await control<ChromeShareState>("/chrome/share/reconnect", {
        generation: state.generation,
        controlId: state.controlId,
      });
      if (alive.current) {
        setState(next);
        setViewer(true);
        setRevision((n) => n + 1);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      controlling.current = false;
      if (alive.current) {
        setBusy(false);
        void load();
      }
    }
  }
  async function handback(cleanupOnly = false) {
    if (controlling.current) return false;
    controlling.current = true;
    ++request.current;
    setBusy(true);
    setError("");
    setViewer(false);
    connection.current?.disconnect();
    connection.current = null;
    try {
      const current = state;
      if (current && (current.owned || (cleanupOnly && current.status === "orphaned"))) {
        doneSent.current = true;
        const next = await control<ChromeShareState>("/chrome/share/release", {
          generation: current.generation,
          controlId: current.controlId,
          cleanupOnly,
        });
        if (alive.current) {
          setState(next);
          onChange();
        }
      }
      return true;
    } catch (e) {
      if (alive.current)
        setError(
          `Viewer cleanup needs retry. Browser agents can continue. ${(e as Error).message}`,
        );
      return true; // Local input is off; cleanup remains recorded for retry.
    } finally {
      controlling.current = false;
      if (alive.current) {
        setBusy(false);
        void load();
      }
    }
  }
  async function closeBrowserSession() {
    if (!agentId || controlling.current) return;
    controlling.current = true;
    ++request.current;
    setBusy(true);
    setError("");
    try {
      await control("/chrome/close", { agentId });
      onChange();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      controlling.current = false;
      if (alive.current) {
        setBusy(false);
        void load();
      }
    }
  }
  const privateOther =
    state &&
    state.status !== "idle" &&
    !state.owned &&
    state.status !== "orphaned";
  return (
    <Modal
      title="Computer control"
      kind="panel"
      className={`chrome-share-panel${connected && viewer && state?.owned && state.status === "sharing" ? " computer-control-active" : ""}`}
      onClose={onClose}
      dismissible={!busy}
      beforeClose={() =>
        state?.owned
          ? handback(state.status === "failed")
          : Promise.resolve(true)
      }
    >
      <div className="computer-control-tools">
      <p id="computer-control-notice" className={`computer-control-notice chat-form-hint${infoOpen ? "" : " compact-collapsed"}`}>
        Full computer access, including other windows and notifications. Browser
        agents may continue while you use it; this is not an exclusive privacy
        lock. Text transfer is available only when you choose it; no file transfer.
      </p>
      {state?.owned && <button className="computer-control-info" type="button"
        aria-label="About computer control" title="About computer control"
        aria-expanded={infoOpen} aria-controls="computer-control-notice"
        onClick={() => setInfoOpen(!infoOpen)}><Info size={20} aria-hidden="true" /></button>}
      {state?.owned && (
        <div className="chrome-share-toolbar">
          <span role="status">
            {connected
              ? "You’re using the computer"
              : state.status === "pausing"
                ? "Connecting…"
                : "Viewer disconnected"}
          </span>
          <div>
            {!connected &&
              ["sharing", "disconnected"].includes(state.status) && (
                <button disabled={busy} onClick={() => void reconnect()}>
                  Reconnect
                </button>
              )}
            <button
              className="primary"
              disabled={busy}
              onClick={() => void handback(state.status === "failed")}
            >
              {state.status === "failed" ? "Retry cleanup" : "Done"}
            </button>
          </div>
        </div>
      )}
      {state?.owned && <ComputerKeyboard
        identity={state.controlId ? { controlId: state.controlId, generation: state.generation } : null}
        connected={connected && viewer && !busy && state.status === "sharing"}
        connection={connection}
      />}
      {state?.owned && <ComputerClipboard
        identity={state.controlId ? { controlId: state.controlId, generation: state.generation } : null}
        connected={connected && viewer && !busy && state.status === "sharing"}
        connection={connection} screen={screen}
      />}
      </div>
      {(error || connectionError || state?.error) && (
        <p role="alert" className="error-text">
          {error || state?.error || connectionError}
        </p>
      )}
      {!state && (
        <button disabled={busy} onClick={() => void load()}>
          Retry
        </button>
      )}
      <ComputerViewport
        displayRef={screen}
        connected={connected}
        fillAvailable
        hidden={!state?.owned || state.status !== "sharing" || !viewer}
        onPan={() => connection.current?.blur()}
      />
      {state?.status === "idle" && (
        <ChatFormCard title="Use the computer" icon={<Monitor size={22} />}>
          {!ownedTarget && !profile?.desktopAvailable && (
            <>
              <p role="status">
                Remote control is unavailable for this computer. Check the host’s
                desktop setup; no other computer will be opened automatically.
              </p>
              {!chrome?.task && state.ownedDesktopAvailable && (
                <button disabled={busy} onClick={() => setUseInstalled(true)}>
                  Use installed computer
                </button>
              )}
            </>
          )}
          {ownedTarget && (
            <p role="status">
              The installed computer is available before Chrome connects.
            </p>
          )}
          <ChatFormActions>
            <button
              className="primary"
              disabled={busy || (!ownedTarget && !profile?.desktopAvailable)}
              onClick={() => void take()}
            >
              {busy ? "Connecting…" : "Take control"}
            </button>
          </ChatFormActions>
        </ChatFormCard>
      )}
      {privateOther && (
        <p role="status">
          The computer viewer is open in another control session. Only that
          session can use or close it.
        </p>
      )}
      {agentId && chrome?.task && (
        <details className="computer-control-advanced">
          <summary>Advanced</summary>
          <h4>This agent’s browser session</h4>
          <p>
            Agents recover expired sessions with browser_reconnect. Close an idle
            session to change its profile/site access or perform operator repair.
            This does not close computer control.
          </p>
          <button disabled={busy} onClick={() => void closeBrowserSession()}>
            Close session
          </button>
        </details>
      )}
      {state?.status === "orphaned" && (
        <ChatFormCard
          title="Viewer cleanup needed"
          icon={<Monitor size={22} />}
          description="An earlier connection was interrupted. Retry cleanup before opening another viewer. Browser agents can continue."
        >
          <ChatFormActions>
            <button disabled={busy} onClick={() => void handback(true)}>
              Retry cleanup
            </button>
          </ChatFormActions>
        </ChatFormCard>
      )}
    </Modal>
  );
}
