let busy = false;
let revision = 0;
async function action(action) {
  if (busy && action !== "disconnect") return;
  const request = ++revision;
  busy = true;
  if (action !== "status") {
    document.querySelector("#tasks").replaceChildren();
  }
  if (action === "connect") document.querySelector("#status").textContent = "Connecting…";
  if (action === "disconnect") document.querySelector("#status").textContent = "Disconnecting…";
  try {
    const result = await chrome.runtime.sendMessage({
      action,
    });
    if (request !== revision) return;
    const errors = {
      "host-missing": "Native host not installed. Install the Jelly Chrome host, then Reconnect.",
      "host-forbidden": "Native host permission denied. Check the extension installation.",
      "host-unavailable": "Jelly or its native host is unavailable or incompatible. Check matching versions; retrying automatically.",
      "handshake-timeout": "Jelly connection timed out. Retrying automatically.",
      "protocol-error": "Incompatible Jelly connection. Retrying automatically.",
      "cleanup-required": "Debugger cleanup required. Reconnect to retry cleanup; do not enter credentials.",
      "initialization-failed": "Local connection initialization failed. Reload the extension.",
      "reconnect-required": "Disconnected by Jelly. Reconnect explicitly to enable access.",
    };
    document.querySelector("#status").textContent = result?.error
      ? "Control failed—do not enter credentials. Retry or reload the extension."
      : result?.pending ? "Connecting…"
      : result?.connected ? "Connected"
      : result?.connecting ? "Connecting…"
      : errors[result?.connectionError] ?? (result?.optedOut
        ? "Disconnected—automatic connection is off. Choose Reconnect to enable it."
        : "Disconnected—waiting to reconnect automatically.");
    if (result?.unresolvedDebuggerCleanup)
      document.querySelector("#status").textContent +=
        " · Debugger cleanup unresolved—retry Reconnect or close affected tabs; do not enter credentials.";
    if (result?.error) {
      document.querySelector("#tasks").replaceChildren();
      return;
    }
    const list = document.querySelector("#tasks");
    list.replaceChildren();
    for (const task of result?.sessions ?? []) {
      const li = document.createElement("li");
      li.textContent = `${task.name}: ${task.failed ? "Security cleanup required" : task.pausing ? "Finishing work" : task.paused ? "Idle or security-paused" : "Working"}, ${task.tabs} tab(s) · ${task.siteScope === "internet" ? "Unrestricted web" : "Approved sites"}`;
      list.append(li);
    }
  } catch {
    if (request === revision) {
      document.querySelector("#status").textContent =
        "Unavailable—do not enter credentials";
      document.querySelector("#tasks").replaceChildren();
    }
  } finally {
    if (request === revision) busy = false;
  }
}
for (const id of ["connect", "disconnect"])
  document.getElementById(id).onclick = () => void action(id);
// Legacy launch fragments never override a persisted Disconnect.
if (window.location.hash)
  window.history.replaceState(null, "", chrome.runtime.getURL("popup.html"));
void action("status");
setInterval(() => void action("status"), 1000);
