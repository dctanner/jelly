import { useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, Check, LoaderCircle } from "lucide-react";
import type { ConnectionStatus, Mode } from "../shared/types";
import { control } from "./api";
export function Connections({
  onConnected,
  only,
  onDirty,
}: {
  onConnected: (mode: Mode) => void;
  only?: "chatgpt" | "api";
  onDirty?: (dirty: boolean) => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const key = useRef<HTMLInputElement>(null),
    callback = useRef<HTMLInputElement>(null),
    seen = useRef("");
  const notify = useRef(onConnected);
  notify.current = onConnected;
  async function load() {
    const next = await control<ConnectionStatus>("/auth/status");
    setStatus(next);
    return next;
  }
  useEffect(() => {
    let dead = false;
    const poll = async () => {
      try {
        const next = await control<ConnectionStatus>("/auth/status");
        if (dead) return;
        setStatus(next);
        if (next.flow && ["starting", "waiting"].includes(next.flow.status))
          seen.current = "pending";
        if (next.flow?.status === "connected" && seen.current === "pending") {
          seen.current = next.flow.id;
          setNotice("ChatGPT connected.");
          notify.current("chatgpt");
        }
      } catch (e) {
        if (!dead) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function saveKey(e: FormEvent) {
    e.preventDefault();
    const value = key.current?.value ?? "";
    if (key.current) key.current.value = "";
    onDirty?.(false);
    void act(async () => {
      await control("/auth/api-key", { key: value });
      setNotice("API key saved. It will be used for your next message.");
      notify.current("api");
    });
  }
  function submitCallback(e: FormEvent) {
    e.preventDefault();
    const value = callback.current?.value ?? "";
    if (callback.current) callback.current.value = "";
    onDirty?.(false);
    void act(async () => {
      await control("/auth/chatgpt/callback", {
        id: status?.flow?.id,
        callback: value,
      });
      setNotice("Completing ChatGPT sign-in…");
    });
  }
  const flow = status?.flow,
    signingIn = flow && ["starting", "waiting"].includes(flow.status);
  return (
    <fieldset className="account-connections">
      <legend>
        {only === "chatgpt"
          ? "ChatGPT account"
          : only === "api"
            ? "API credentials"
            : "Connect an account"}
      </legend>
      {only !== "api" && (
        <div className="account-block">
          <div className="account-title">
            <strong>ChatGPT</strong>
            {status?.chatgptReady && (
              <span>
                <Check size={14} /> Connected
              </span>
            )}
          </div>
          <p className="subtle">
            Use your ChatGPT subscription through Pi’s Codex connection.
          </p>
          {signingIn ? (
            <div className="login-progress">
              <p>
                <LoaderCircle size={14} className="spin" /> Waiting for sign-in
              </p>
              {flow.url && (
                <a
                  className="auth-link"
                  href={flow.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Continue to ChatGPT <ExternalLink size={14} />
                </a>
              )}
              <p className="subtle">
                Sign in in the new tab, then return here. Jelly updates
                automatically.
              </p>
              <details>
                <summary>Sign-in tab didn’t return?</summary>
                <form onSubmit={submitCallback}>
                  <label>
                    Callback URL
                    <input
                      ref={callback}
                      onChange={(e) => onDirty?.(!!e.target.value)}
                      type="password"
                      autoComplete="off"
                      maxLength={16000}
                      placeholder="http://localhost:1455/auth/callback?…"
                      required
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    Complete sign-in
                  </button>
                </form>
              </details>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await control("/auth/chatgpt/cancel", { id: flow.id });
                  })
                }
              >
                Cancel sign-in
              </button>
            </div>
          ) : (
            <div className="account-actions">
              <button
                type="button"
                disabled={busy || status?.busy}
                onClick={() =>
                  void act(async () => {
                    await control("/auth/chatgpt/start");
                    seen.current = "pending";
                  })
                }
              >
                {status?.chatgptReady ? "Reconnect ChatGPT" : "Connect ChatGPT"}
              </button>
              {status?.chatgptReady && (
                <button
                  type="button"
                  disabled={busy || status.busy}
                  onClick={() =>
                    void act(async () => {
                      await control("/auth/remove", {
                        provider: "openai-codex",
                      });
                      notify.current("auto");
                    })
                  }
                >
                  Disconnect
                </button>
              )}
            </div>
          )}
          {flow?.error && (
            <p className="error-text" role="alert">
              {flow.error}
            </p>
          )}
          {status?.busy && !signingIn && (
            <p className="subtle">
              Another sign-in is in progress. Finish it before changing
              credentials.
            </p>
          )}
        </div>
      )}
      {only !== "chatgpt" && (
        <div className="account-block">
          <div className="account-title">
            <strong>OpenAI API key</strong>
            {status?.apiReady && (
              <span>
                <Check size={14} /> Configured
              </span>
            )}
          </div>
          <p className="subtle">
            API usage is billed separately from ChatGPT.{" "}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              Create an API key
            </a>
          </p>
          <form onSubmit={saveKey}>
            <label>
              {status?.apiStored ? "Replace saved API key" : "API key"}
              <input
                ref={key}
                onChange={(e) => onDirty?.(!!e.target.value)}
                type="password"
                aria-label="OpenAI API key"
                autoComplete="off"
                spellCheck={false}
                maxLength={1024}
                placeholder="sk-…"
                required
                disabled={busy || status?.busy}
              />
            </label>
            <div className="account-actions">
              <button type="submit" disabled={busy || status?.busy}>
                Save API key
              </button>
              {status?.apiStored && (
                <button
                  type="button"
                  disabled={busy || status.busy}
                  onClick={() =>
                    void act(async () => {
                      await control("/auth/remove", { provider: "openai" });
                      notify.current("auto");
                    })
                  }
                >
                  Remove saved key
                </button>
              )}
            </div>
          </form>
          {status?.apiSource === "environment" && (
            <p className="subtle">
              A key is also configured in the server environment.
            </p>
          )}
          <p className="subtle">
            Saved privately on this Jelly computer, never in chat or browser
            storage. The next model request checks access.
          </p>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="connection-success" role="status">
          {notice}
        </p>
      )}
    </fieldset>
  );
}
