import { useEffect, useRef, useState } from "react";
import { Monitor } from "lucide-react";
import { api, control } from "./api";
import { Modal } from "./Modal";
import { ChatFormActions, ChatFormCard } from "./ChatFormCard";
import { useVncViewer } from "./useVncViewer";
import type { ChromeStatus } from "./ChromeConnection";
import type { ChromeShareState } from "../shared/chrome-share";

export function ChromeSharePanel({
  agentId,
  onClose,
  onChange,
}: {
  agentId: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const [state, setState] = useState<ChromeShareState | null>(null);
  const [chrome, setChrome] = useState<ChromeStatus | null>(null);
  const [desktopTarget, setDesktopTarget] = useState<"selected" | "owned" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [revision, setRevision] = useState(0),
    [viewer, setViewer] = useState(true);
  const alive = useRef(true),
    controlling = useRef(false),
    request = useRef(0);
  const selected = chrome?.task?.profile ?? chrome?.selectedProfile;
  const profile = chrome?.profiles.find((p) => p.id === selected);
  async function load() {
    if (controlling.current) return;
    const id = ++request.current;
    try {
      await api("/control-session");
      const [next, status] = await Promise.all([
        api<ChromeShareState>("/chrome/share"),
        api<ChromeStatus>(`/chrome?agentId=${encodeURIComponent(agentId)}`),
      ]);
      if (alive.current && id === request.current) {
        setState(next);
        setChrome(status);
        setDesktopTarget(target => target ?? (status.profiles.some(p => p.id === (status.task?.profile ?? status.selectedProfile)) ? "selected" : next.ownedDesktopAvailable ? "owned" : "selected"));
      }
    } catch (e) {
      if (alive.current && id === request.current) {
        setState(null);
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
    };
  }, [agentId]);
  const { screen, connection, connected, connectionError } = useVncViewer({
    enabled: viewer && state?.status === "sharing" && state.owned,
    interactive: true,
    revision,
    socketPath: "/api/chrome/share/socket",
    requestTicket: async () => {
      const current = await api<ChromeShareState>("/chrome/share");
      const next = await control<{ ticket: string; generation: number }>(
        "/chrome/share/ticket",
        { generation: current.generation },
      );
      if (alive.current)
        setState((s) =>
          s && s.owned ? { ...s, generation: next.generation } : s,
        );
      return next.ticket;
    },
  });
  async function take() {
    const ownedTarget = desktopTarget === "owned";
    if (controlling.current || (ownedTarget ? !state?.ownedDesktopAvailable : !profile?.desktopAvailable)) return;
    controlling.current = true;
    ++request.current;
    setBusy(true);
    setError("");
    try {
      const next = await control<ChromeShareState>(!ownedTarget ? "/chrome/share/take" : "/chrome/share/take-owned", !ownedTarget && profile ? {
        agentId, profile: profile.id, profileGeneration: profile.generation,
      } : { agentId });
      if (alive.current) {
        setState(next);
        setViewer(true);
        setRevision((n) => n + 1);
        onChange();
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
    if (controlling.current) return;
    controlling.current = true;
    ++request.current;
    setBusy(true);
    setError("");
    try {
      const current = await api<ChromeShareState>("/chrome/share");
      const next = await control<ChromeShareState>("/chrome/share/reconnect", {
        generation: current.generation,
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
    try {
      const current = await api<ChromeShareState>("/chrome/share");
      if (current.owned || (cleanupOnly && current.status === "orphaned")) {
        const next = await control<ChromeShareState>("/chrome/share/release", {
          generation: current.generation,
          cleanupOnly,
          resume: !cleanupOnly,
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
          `Could not return control. Browser tools remain paused; retry. ${(e as Error).message}`,
        );
      return false;
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
      title="Connected Chrome desktop"
      kind="panel"
      className="chrome-share-panel"
      onClose={onClose}
      dismissible={!busy}
      beforeClose={() => handback()}
    >
      {state?.owned && (
        <div className="chrome-share-toolbar">
          <span role="status">
            Connected Chrome browser tools paused ·{" "}
            {connected
              ? "You control the full desktop"
              : state.status === "pausing"
                ? "Draining browser and desktop work—do not enter credentials"
                : "Disconnected or sharing stopped"}
          </span>
          <div>
            <button
              disabled={
                busy || !["sharing", "disconnected"].includes(state.status)
              }
              onClick={() => void reconnect()}
            >
              Reconnect desktop
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void handback(state.status === "failed")}
            >
              {state.status === "failed"
                ? "End failed share without viewing"
                : "Return control"}
            </button>
          </div>
        </div>
      )}
      {(error || connectionError || state?.error) && (
        <p role="alert" className="error-text">
          {error || state?.error || connectionError}
        </p>
      )}
      <div className="chrome-share-viewer" hidden={!state?.owned || state.status !== "sharing" || !viewer}>
        <div className="chrome-share-screen">
          <div className="chrome-share-display" ref={screen} />
        </div>
      </div>
      {state?.status === "idle" && (
        <ChatFormCard
          title="Take control of Connected Chrome"
          status="Ready for your control"
          icon={<Monitor size={22} />}
          description="This shares and controls the full Linux X11 desktop used by Connected Chrome. Other windows, accounts, notifications and unrelated private content may be visible and controllable. This is not a browser-tab-only share."
        >
          <p className="chat-form-hint">
            All Connected Chrome browser tools and Jelly desktop tools in this
            instance pause and detach before capture starts. Only this Jelly
            control session can view or control the share. The model receives no
            desktop pixels. Clipboard transfer and files are unavailable.
            Closing returns control; a network disconnect leaves tools paused.
            Disconnect/handback releases held keys and mouse buttons; cleanup
            may also release keys/buttons held on the physical keyboard or
            mouse. Other local applications and unrestricted same-user shell
            access are outside this privacy barrier.
          </p>
          {state.ownedDesktopAvailable && profile && <label>
            Desktop source
            <select aria-label="Desktop source" value={desktopTarget ?? "selected"} onChange={e => setDesktopTarget(e.target.value as "selected" | "owned")}>
              <option value="selected">Selected Connected Chrome profile{profile.desktopAvailable ? "" : " — desktop unavailable"}</option>
              <option value="owned">Installed owned virtual-X11 desktop</option>
            </select>
          </label>}
          {desktopTarget === "owned" && <p role="status">
            Owned virtual-X11 desktop is ready{!profile ? " before Chrome pairing" : ""}. Take control
            to authenticate privately in the OS keyring window. If not connected,
            Connect the extension once; pairing stays unpublished until verified handback.
            The normal Chrome profile stays on this desktop after you return.
          </p>}
          {desktopTarget !== "owned" && !profile?.desktopAvailable && (
            <p role="status">
              Web VNC unavailable. Requires local Linux X11, native-host DISPLAY
              and private XAUTHORITY, plus x11vnc. Wayland, remote displays,
              macOS and Windows are unavailable. Use Open in Chrome locally.
            </p>
          )}
          <ChatFormActions>
            <button disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || (desktopTarget === "owned" ? !state.ownedDesktopAvailable : !profile?.desktopAvailable)}
              onClick={() => void take()}
            >
              {busy ? "Pausing—do not enter credentials yet" : "Take control"}
            </button>
          </ChatFormActions>
        </ChatFormCard>
      )}
      {privateOther && (
        <p role="status">
          Private desktop share owned by another control session. No viewing or
          takeover is available.
        </p>
      )}
      {state?.status === "orphaned" && (
        <ChatFormCard
          title="End interrupted desktop share"
          icon={<Monitor size={22} />}
          description="The previous owner was lost during a Jelly restart. This only verifies and stops the old VNC process/input without viewing. It never restores old tasks, closes Chrome or transfers screen ownership. If cleanup cannot be proven, tools stay paused and operator repair is needed."
        >
          <ChatFormActions>
            <button disabled={busy} onClick={onClose}>
              Keep paused
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void handback(true)}
            >
              End orphaned desktop share without viewing
            </button>
          </ChatFormActions>
        </ChatFormCard>
      )}
      <p className="subtle">
        Viewer handback never restarts Chrome or copies its profile. Owned X11
        Chrome persists independently of Jelly; installation/relaunch is a separate
        owner operation with profile-lock and unsaved-state risks. No clipboard export. After handback, other tasks stay paused and need their own
        explicit Resume.
      </p>
    </Modal>
  );
}
