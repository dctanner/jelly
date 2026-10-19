function choices(selector, entries) {
  const select = document.querySelector(selector),
    previous = select.value;
  const options = entries.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    return option;
  });
  select.replaceChildren(new Option("Choose explicitly…", ""), ...options);
  select.value = entries.some(([value]) => String(value) === previous)
    ? previous
    : "";
}
let busy = false;
let revision = 0;
async function action(action) {
  if (busy && !["pause", "disconnect"].includes(action)) return;
  const request = ++revision;
  const grant =
    action === "grant"
      ? {
          session: document.querySelector("#session").value,
          tab: Number(document.querySelector("#tab").value),
        }
      : {};
  busy = true;
  if (action !== "status") {
    document.querySelector("#tasks").replaceChildren();
    choices("#session", []);
    choices("#tab", []);
  }
  if (action === "pause")
    document.querySelector("#status").textContent =
      "Pausing—do not enter credentials yet";
  try {
    const result = await chrome.runtime.sendMessage({
      action,
      ...grant,
    });
    if (request !== revision) return;
    document.querySelector("#status").textContent =
      (result?.error ? "Unavailable—do not enter credentials" : null) ??
      `${result?.pending ? "Connection pending—return control in Jelly web desktop to publish" : result?.connected ? "Connected" : "Disconnected"} · Profile ${result?.profile ?? ""} · Instance ${result?.instance ?? "none"}`;
    if (result?.unresolvedDebuggerCleanup)
      document.querySelector("#status").textContent +=
        " · Debugger cleanup unresolved—retry Connect or close affected tabs; do not enter credentials.";
    if (result?.error) {
      document.querySelector("#tasks").replaceChildren();
      return;
    }
    const list = document.querySelector("#tasks");
    list.replaceChildren();
    for (const task of result?.sessions ?? []) {
      const li = document.createElement("li");
      li.textContent = `${task.name}: ${task.failed ? "Pause failed—do not enter credentials" : task.pausing ? "Pausing—do not enter credentials yet" : task.paused ? "paused" : "working"}, ${task.tabs} tab(s) · ${task.siteScope === "internet" ? "Unrestricted internet" : "Approved sites"}`;
      list.append(li);
    }
    choices(
      "#session",
      (result?.sessions ?? [])
        .filter((s) => !s.paused && !s.pausing && !s.failed)
        .map((s) => [s.id, s.name]),
    );
    choices(
      "#tab",
      (result?.candidates ?? []).map((t) => [t.id, `${t.title} · ${t.url}`]),
    );
  } catch {
    if (request === revision) {
      document.querySelector("#status").textContent =
        "Unavailable—do not enter credentials";
      document.querySelector("#tasks").replaceChildren();
      choices("#session", []);
      choices("#tab", []);
    }
  } finally {
    if (request === revision) busy = false;
  }
}
for (const id of ["connect", "pause", "disconnect", "grant"])
  document.getElementById(id).onclick = () => void action(id);
// An explicit operator launch may request a one-shot connection. Consume the
// fragment before messaging so sender.url remains the canonical packaged page.
// Ordinary popup opens and later reloads never reconnect automatically.
const connectOnce = window.location.hash === "#connect";
if (connectOnce)
  window.history.replaceState(null, "", chrome.runtime.getURL("popup.html"));
void action(connectOnce ? "connect" : "status");
setInterval(() => void action("status"), 3000);
