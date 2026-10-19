import { useEffect, useState } from "react";
import { api } from "./api";
import { Modal } from "./Modal";
import { ComputerPanel } from "./ComputerPanel";
import { ChromeSharePanel } from "./ChromeSharePanel";
import type { ChromeStatus } from "./ChromeConnection";

/** Resolve the pinned session, never infer it solely from global configuration. */
export function BrowserPanel(props: {
  agentId: string;
  onClose: () => void;
  onChange: () => void;
  navigationNotice?: string;
}) {
  const [target, setTarget] = useState<"managed" | "chrome" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let dead = false;
    void (async () => {
      await api("/control-session");
      const status = await api<ChromeStatus>(
        `/chrome?agentId=${encodeURIComponent(props.agentId)}`,
      );
      if (!dead)
        setTarget(status.browserTarget ?? (status.task ? "chrome" : "managed"));
    })().catch((e) => {
      if (!dead) setError(e.message);
    });
    return () => {
      dead = true;
    };
  }, [props.agentId]);
  if (!target)
    return (
      <Modal title="Browser" kind="panel" onClose={props.onClose}>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p>Checking pinned browser target…</p>
        )}
      </Modal>
    );
  return target === "chrome" ? (
    <ChromeSharePanel {...props} />
  ) : (
    <ComputerPanel {...props} />
  );
}
