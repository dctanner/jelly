import type { HistoryPage, Snapshot } from "../shared/types";

export function snapshotHistory(snapshot: Snapshot): HistoryPage {
  return {
    events: snapshot.events,
    runs: snapshot.runs,
    interventions: snapshot.interventions,
    before: snapshot.historyBefore,
  };
}

/** Keep the oldest cursor, deduplicate overlaps, and prefer live record updates. */
export function mergeHistory(
  older: HistoryPage,
  newer: HistoryPage,
): HistoryPage {
  return {
    before: older.before,
    events: [
      ...new Map(
        [...older.events, ...newer.events].map((e) => [e.id, e]),
      ).values(),
    ].sort((a, b) => a.id - b.id),
    runs: [
      ...new Map([...older.runs, ...newer.runs].map((r) => [r.id, r])).values(),
    ],
    interventions: [
      ...new Map(
        [...older.interventions, ...newer.interventions].map((i) => [i.id, i]),
      ).values(),
    ],
  };
}

export interface ScrollAnchor {
  key?: string;
  offset: number;
  height: number;
  top: number;
}

export function captureAnchor(chat: HTMLElement): ScrollAnchor {
  const top = chat.getBoundingClientRect().top;
  const element = [
    ...chat.querySelectorAll<HTMLElement>("[data-activity-key]"),
  ].find((item) => item.getBoundingClientRect().bottom > top);
  return {
    key: element?.dataset.activityKey,
    offset: element ? element.getBoundingClientRect().top - top : 0,
    height: chat.scrollHeight,
    top: chat.scrollTop,
  };
}

export function restoreAnchor(chat: HTMLElement, anchor: ScrollAnchor) {
  const element =
    anchor.key &&
    [...chat.querySelectorAll<HTMLElement>("[data-activity-key]")].find(
      (item) => item.dataset.activityKey === anchor.key,
    );
  // Scrolling can continue between capture and layout/ResizeObserver delivery.
  // Preserve that movement; only compensate for the content's size change.
  const movement = chat.scrollTop - anchor.top;
  const top = element
    ? chat.scrollTop +
      element.getBoundingClientRect().top -
      chat.getBoundingClientRect().top -
      (anchor.offset - movement)
    : anchor.top + movement + chat.scrollHeight - anchor.height;
  // A no-op scrollTo can interrupt touch momentum on mobile browsers.
  if (Math.abs(top - chat.scrollTop) > 0.5)
    chat.scrollTo({ top, behavior: "instant" });
}
