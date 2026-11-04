import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Pi 0.87.1 can invoke a provider with an already-aborted signal after compaction.
 * Use the public request boundary as well as cancellation, never a provider patch. */
export function guardRunRequests(
  session: AgentSession,
  stopped: () => boolean,
) {
  const previous = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    const check = () => {
      if (stopped()) {
        // Preflight may have reset Pi's abort flag. Reassert cancellation so a
        // rejected request cannot trigger recovery compaction or queued work.
        // Never await idle from inside the request boundary.
        void session.abort();
        throw new Error(
          "Execution stopped. Explicit operator action is required.",
        );
      }
    };
    check();
    const result = await previous?.(request, signal);
    check();
    return result ?? undefined;
  };
}
