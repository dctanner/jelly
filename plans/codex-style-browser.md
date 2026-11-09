# Codex-style Connected Chrome (rebuild spec)

Goal: Jelly's Connected Chrome works the same way as the OpenAI Codex Chrome plugin
(extension 1.26.1102), so it is as fast, token-efficient and robust. Reference
analysis: `$SCRATCH/codex-chrome-analysis.md` (§ numbers below refer to it), where
`$SCRATCH=/private/tmp/claude-501/-Users-dctanner-projects-jelly/7e5b40ac-ed6e-4a61-802d-4d9ff49568e2/scratchpad`.

Owner decisions (user, 2026-11-08):
- Agents drive the browser with a persistent **JS REPL** (`browser_js` tool), like Codex's `node_repl` `js` tool.
- **Full browser control, no refusals or checks.** No secret-field/page refusals, no frame/shadow/screenshot
  blocks, no protected-origin blocking, no navigation-policy pauses, no credential redaction, coordinates and
  any key allowed, raw CDP allowed, user tabs claimable, chrome.* management APIs available.

## Architecture (mirrors Codex §1)

```
model code (browser_js tool) ── Bun Worker running a persistent vm context        [src/server/browser/repl*.ts]
   │  browser / tab / tab.ax / tab.cdp API objects → host RPC {op, args}
   ▼
BrowserEngine (Jelly server, one per agent session)                                [src/server/browser/engine.ts ...]
   │  AX capture + renderer + diff, settle state machine, actions, screenshots, dialogs
   │  uses ChromePort: call(method, params) + onEvent(cdpEvent/cdpDetach/tabAdded/tabRemoved)
   ▼
ChromeSessions / ChromeBridge (existing session/run authority, unix socket)        [src/server/chrome-*.ts]
   ▼
native host (unchanged framing)                                                      [scripts/chrome-native-host.ts]
   ▼
extension worker = thin CDP relay + tabs/leases/groups                              [extensions/chrome/worker.js]
```

## 1. Extension protocol v9 (`src/shared/chrome-protocol.ts`, `extensions/chrome/worker.js`)

Framing, pairing/hello/pending/paired, instance/generation/session/run envelope, freeze/unfreeze, popup
UI, reconnect alarms: unchanged. `CHROME_PROTOCOL = 9`. Max frame: requests server→extension stay small;
raise `CHROME_MAX_FRAME` to 32 MiB (Chrome→host native messages may be large: DOMSnapshot results).
Native messaging host→Chrome is limited by Chrome to 1 MiB; server→extension requests must stay < 1 MiB.

Requests are processed **concurrently** (no global queue). Per-tab attach/detach is serialised with a per-tab
promise chain. Per-session lifecycle ops (begin/end/pause/resume) are serialised per session.

Errors: `{error:{code:-32000, message:<real, specific message>}}`. The bridge rejects with `new Error(message)`
(truncate to 2000 chars). No generic "Unavailable or revoked" masking.

Methods (params → result). Tab ids are Chrome's numeric tab ids.
| method | params | result / behaviour |
|---|---|---|
| `begin` | `{name, agent?}` | start/resume session for this run; re-lease retained handoff tabs that still exist → `{ok:true, tabs:[tabId]}` |
| `end` | `{discard?}` | turn end (§7): unmarked agent tabs closed; unmarked claimed user tabs released (left open); `deliverable` kept, removed from agent group, released; `handoff` kept + retained for next begin (unless discard). Detach debuggers of everything released/closed. → `{ok:true, retained:[tabId]}` |
| `pause` / `resume` | `{}` | pause: detach debuggers, refuse non-lifecycle ops until resume. Keep existing pauseState notifications. |
| `name` | `{name}` | set group title `🔎 <name>` (no forced prefixes beyond what the server passes) |
| `createTab` | `{url?}` | `chrome.tabs.create({active:false,url:'about:blank'})` in the window of the session's last tab, else last focused normal window, else unfocused new window; group into session group; lease origin `agent`; if url, `chrome.tabs.update(url)` → `{tab:TabInfo}` |
| `closeTab` | `{tabId}` | detach + remove (agent or claimed) → `{ok}` |
| `listTabs` | `{}` | session tabs → `{tabs:TabInfo[]}` |
| `userTabs` | `{}` | all normal-window tabs not leased by another session, ordered by lastAccessed desc → `{tabs:UserTabInfo[]}` |
| `claimTab` | `{tabId}` | lease with origin `user` (not regrouped) → `{tab:TabInfo}` |
| `markTab` | `{tabId, mark: "deliverable"\|"handoff"\|null}` | turn-scoped mark |
| `showTab` | `{tabId}` | activate tab + focus its window |
| `attach` | `{tabId}` | idempotent `chrome.debugger.attach({tabId},"1.3")` ("Another debugger" ⇒ treat as attached if ours) → `{ok}` |
| `detach` | `{tabId}` | `{ok}` |
| `cdp` | `{tabId, sessionId?, method, params?, timeoutMs?}` | `chrome.debugger.sendCommand({tabId, sessionId?}, method, params)`; auto-attach first if not attached; timeout default 10000 ms → reject `Timed out running CDP command "<method>"` (do NOT detach). Result returned as-is. |
| `chrome` | `{namespace, method, args:[]}` | full-control passthrough: `chrome[namespace][method](...args)` for namespaces `tabs, windows, tabGroups, bookmarks, history, downloads, sessions, topSites, cookies`. Result as-is (JSON). |

TabInfo = `{id, title, url, windowId, active (chrome active flag), origin:"agent"|"user", mark}`.
UserTabInfo = `{id, title, url, windowId, active, lastAccessed, groupId, pinned}`.

Notifications extension→server (no id; include `generation`, `session`, `run`):
- `cdpEvent {tabId, sessionId?, method, params}` — every `chrome.debugger.onEvent` for leased tabs.
- `cdpDetach {tabId, reason}` — `chrome.debugger.onDetach` for leased tabs (session is NOT paused; engine re-attaches lazily on next call, except `canceled_by_user` which the engine reports to the model as "Browser use was stopped in Chrome").
- `tabAdded {tab:TabInfo}` — popup/`target=_blank` from a leased tab is auto-leased (origin agent, grouped). No URL policy.
- `tabRemoved {tabId}`.
- `pauseState` — unchanged.

Removed entirely: DNR rules / `chrome-policy.ts` deny regexes, protected origins, navigation-denied pauses,
observation.js and all guards, opaque/inherited frame logic, document guards, refs/epochs, screenshot guards.
Manifest permissions: add `bookmarks, history, downloads, sessions, topSites, cookies`; drop `scripting`,
`declarativeNetRequest` if unused.

Dead-man switch (Codex §1.4): 30 s alarm; if the native port is down, detach all our debuggers.

## 2. AX renderer (`src/server/browser/ax-render.ts`) — Codex §2.1–2.5

Pure, synchronous, no I/O. Input:
```ts
interface AXInputNode {
  parentIndex: number;          // -1 for root; parents precede children
  identity: string;             // stable identity, e.g. `${tabId}|${sessionId??""}|${backendDOMNodeId}`
  role: string;                 // CDP AXNode.role.value (e.g. "RootWebArea","button","StaticText","generic")
  name: string | null;
  nameSource?: "contents"|"placeholder"|"relatedElement"|"attribute"|"value"|null;
  description: string | null;
  value: string | number | boolean | null;
  properties: Record<string, unknown>; // whitelisted CDP AX properties, values unwrapped (expanded, checked, settable/editable, disabled, focused, selected, level, hasPopup, roledescription, url, valuetext, placeholder, required, invalid, pressed, multiline, ...)
  dom?: { tagName?: string|null; id?: string|null; inputType?: string|null };
  isDialogControl?: boolean;
}
interface AXSnapshot { tab: { id: number; title: string; url: string }; nodes: AXInputNode[]; dialog?: {...} }
interface AXRevision { ids: Map<string, number>; byId: Map<number, string /*identity*/>; nextId: number; lines: Map<number,string> /*rendered line per id*/; order: number[]; text: string; documentKey: string; settable: Map<number, boolean> }
function renderRevision(snapshot: AXSnapshot, previous: AXRevision | null, opts: { mode: "auto"|"full"; documentKey: string; minSavedChars?: number /*1000*/; minSavedRatio?: number /*0.30*/ }): { revision: AXRevision; text: string /*full or diff, without the "Browser tab:" header*/; diff: boolean }
```
Output text must match Codex's format (§2.3 line grammar, role words, flags, `Value:`/`Description:`/
`Placeholder:`/`ID:`/`Help:`/`Details:`/`Secondary Actions:` keys, pruning rules, 500-child cap with
`(showing 0-500 of N items)`, depth cap 200, URL stripping + adaptive shortening §2.5, footer
`The focused UI element is …`), diff format §2.4 exactly (header sentence, `Removed element IDs:` ranges,
`~`/`+` prefixed original lines with absolute indentation, no-change single line), and thresholds
(≥1000 chars and ≥30 % saved; otherwise full). IDs stable by identity across revisions, never reused,
new nodes get ids above previous max. If `documentKey` differs from previous → full render but still keep
id continuity rules (new numbering continues from nextId).
Test oracle: the Codex WASM harness in `$SCRATCH/work/harness/` may be used locally (never shipped).

## 3. Engine (`src/server/browser/engine.ts`, `capture.ts`, `actions.ts`, `page-scripts.ts`, `keys.ts`)

Engine implements host ops (below) over a `ChromePort`:
```ts
interface ChromePort {
  call(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<any>; // extension RPC (§1)
  onEvent(listener: (event: ChromePortEvent) => void): () => void;
}
type ChromePortEvent =
  | { type: "cdpEvent"; tabId: number; sessionId?: string; method: string; params: any }
  | { type: "cdpDetach"; tabId: number; reason: string }
  | { type: "tabAdded"; tab: TabInfo } | { type: "tabRemoved"; tabId: number };
```
Capture pipeline §2.1, settle state machine §4 with Codex constants (Appendix A), actions §3, screenshots §5
(JPEG q80, CSS pixels), dialogs §2.6, popups §3.8, file inputs via `DOM.setFileInputFiles`.

## 4. REPL (`src/server/browser/repl.ts`, `repl-worker.ts`, `client-api.ts`)

Tool `browser_js` `{code: string, timeout_ms?: number}` (default 30 000, max 600 000). Persistent per agent:
top-level `const/let/class/function` persist across calls (transform top-level declarations so they survive,
support top-level `await`). Runs in a Bun `Worker` so a hung cell can be terminated (then state is reset and
the result says so). Globals: `browser`, `display(value)`, `nodeRepl.write(text)`, `console.*` (captured),
`setTimeout` etc. Output = ordered content items (text, images). Errors: message + stack trimmed to user code.
Display cap 100 000 chars per item (`…[truncated N chars]`).

Host RPC: worker posts `{id, op, args}`; host replies `{id, result}` / `{id, error}`. `side_effects` not needed.
Ops (args → result):
```
nameSession {name}
tabs.list {} → TabInfo[] ; tabs.new {url?} → TabInfo ; tabs.get {id} → TabInfo
user.openTabs {} → UserTabInfo[] ; user.claimTab {id} → TabInfo
chrome {namespace, method, args}
tab.info {tab} → TabInfo (fresh title/url) ; tab.goto {tab,url,timeoutMs?} ; tab.back/forward/reload {tab}
tab.close {tab} ; tab.show {tab} ; tab.mark {tab, mark:"deliverable"|"handoff"|null}
tab.screenshot {tab, fullPage?, clip?:{x,y,width,height}} → {data, mimeType:"image/jpeg", width, height}
tab.ax.get {tab, mode:"state"|"screenshot"|"both", disableDiffing?} → {state?: string, screenshot?: {data,mimeType}}
tab.ax.action {tab, action} where action.kind ∈ click{target:number|[x,y], mouseButton?, clickCount?, key?, duration?}
   | set_value{element_index, value} | type_text{element_index|null, text} | paste{element_index|null, text, format?}
   | press_key{element_index|null, key, duration?} | scroll{target, direction:"up"|"down"|"left"|"right", pages?}
   | select_text{element_index, text, prefix?, suffix?, selection_type?} | perform_secondary_action{element_index, action}
   | drag{from, to} | hover{target}
tab.evaluate {tab, expression? , functionDeclaration?, arg?, elementIndex?} → JSON value (awaitPromise, returnByValue)
tab.cdp {tab, method, params?, sessionId?} → raw result
tab.cdp.events {tab, afterSequence?, methods?, limit?, timeoutMs?} → {cursor, events, hasMore, truncated}
tab.setFiles {tab, element_index, paths:string[]}
tab.dialog {tab} → null | {type, message, defaultPrompt} ; tab.handleDialog {tab, accept, promptText?}
tab.waitForLoad {tab, state?:"load"|"domcontentloaded"|"networkidle", timeoutMs?}
```
Client-side API (in the worker) mirrors Codex: `browser.nameSession`, `browser.tabs.{list,new,get}`,
`browser.user.{openTabs,claimTab}`, `browser.chrome.<namespace>.<method>(...args)`, `Tab` objects with `id`,
`goto/back/forward/reload/url/title/close/show/markDeliverable/markHandoff/screenshot/evaluate/setFiles/
dialog/handleDialog/waitForLoad`, `tab.ax.{get,write,click,setValue,typeText,paste,pressKey,scroll,selectText,
performSecondaryAction,drag,hover}`, `tab.cdp.{send,events}`. `tab.ax.write(mode)` displays state text and/or
screenshot image; `tab.screenshot()` returns `{data,mimeType,...}` and `display(shot)` shows it.
