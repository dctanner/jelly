import { useEffect, useMemo, useState } from "react";
import { readPreference, savePreference } from "./theme";

function loadReadMessages(instance: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(
      readPreference(`jelly.read.${instance}`, "{}"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, id]) =>
          typeof id === "number" && Number.isSafeInteger(id) && id >= 0,
      ),
    );
  } catch {
    return {};
  }
}

/** Read receipts are local to this browser and isolated by Jelly instance. */
export function useUnreadMessages(
  instance: string,
  latest: Record<string, number> | undefined,
  openAgent: string | null,
): Set<string> {
  const saved = useMemo(() => loadReadMessages(instance), [instance]);
  const [read, setRead] = useState({ instance, messages: saved });
  const messages = read.instance === instance ? read.messages : saved;
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const viewing = visible ? openAgent : null;
  const latestViewed = viewing ? (latest?.[viewing] ?? 0) : 0;
  useEffect(() => {
    if (!instance || !viewing || latestViewed <= (messages[viewing] ?? 0))
      return;
    const next = { ...messages, [viewing]: latestViewed };
    setRead({ instance, messages: next });
    savePreference(`jelly.read.${instance}`, JSON.stringify(next));
  }, [instance, viewing, latestViewed, messages]);
  return new Set(
    Object.entries(latest ?? {})
      .filter(
        ([id, message]) => id !== viewing && message > (messages[id] ?? 0),
      )
      .map(([id]) => id),
  );
}
