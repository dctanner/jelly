/**
 * Model-facing documentation for the `browser_js` tool (plans/codex-style-browser.md §4).
 * Token-sensitive: keep terse. Adapted from Codex's Chrome plugin docs (api-use-behavior,
 * accessibility, tab-cleanup, tab-claiming, file-uploads, screenshots, session-naming).
 */

export const BROWSER_JS_DESCRIPTION = `Run JavaScript in a persistent async REPL that controls the user's Chrome (Connected Chrome). Full control: any site, any key, raw CDP, chrome.* APIs.

REPL:
- State persists across calls: top-level const/let/var/function/class become REPL globals. Use const for stable handles (tabs), let for changing values; redeclaring a name overwrites it.
- Top-level await works. The last expression's value is displayed if not undefined (strings raw, objects inspected).
- Output: console.log/info/warn/error, display(value) (images for {data, mimeType:"image/*"} or data:image URLs), nodeRepl.write(text). Each item is capped at 100 000 chars.
- Also available: sleep(ms), setTimeout etc., fetch, Buffer, require (node builtins, e.g. require("node:fs")), process.
- timeout_ms: default 30000, max 600000. On timeout the REPL restarts and ALL state is lost (tabs stay open; reacquire with browser.tabs.list()).
- Errors show the message and stack frames inside your cell.

API (\`browser\` is ready; no setup):
browser.nameSession(name)                       // tab-group title; start with an emoji, e.g. "🔎 Flights"
browser.tabs.list(): Tab[]                      // this session's tabs (same Tab object per id)
browser.tabs.new(url?): Tab                     // new background tab in the session group
browser.tabs.get(id): Tab
browser.user.openTabs(): UserTabInfo[]          // user's tabs {id,title,url,windowId,active,lastAccessed,groupId,pinned}, most recent first
browser.user.claimTab(tabOrId): Tab             // take control of a user tab (object from openTabs() or its id)
browser.chrome.<ns>.<method>(...args)           // chrome.* passthrough: tabs, windows, tabGroups, bookmarks, history, downloads, sessions, topSites, cookies (JSON args/results, no callbacks)

Tab:
tab.id                                          // Chrome tab id (number)
tab.lastInfo                                    // last-known {id,title,url,windowId,active,origin,mark}; may be stale
tab.info() / tab.url() / tab.title()            // fresh values
tab.goto(url, {timeoutMs}?) / back() / forward() / reload()
tab.close() / tab.show()                        // show = activate tab + focus window
tab.markDeliverable() / tab.markHandoff() / tab.unmark()
tab.screenshot({fullPage?, clip?:{x,y,width,height}}?): {data (base64), mimeType:"image/jpeg", width, height}
tab.evaluate(exprOrFn, arg?, {elementIndex}?)   // runs in the page; awaits promises; returns JSON. fn gets arg; with elementIndex, this = that element's DOM node
tab.setFiles(elementIndex, ["/abs/path"])       // set files on a file input element
tab.dialog(): null | {type, message, defaultPrompt}
tab.handleDialog(accept, promptText?)
tab.waitForLoad(state?: "load"|"domcontentloaded"|"networkidle", {timeoutMs}?)
tab.cdp.send(method, params?, {sessionId}?)     // raw CDP command → result
tab.cdp.events({afterSequence?, methods?, limit?, timeoutMs?}?) → {cursor, events, hasMore, truncated}

tab.ax (accessibility; primary way to read and act):
tab.ax.write(mode="state", {disableDiffing}?)   // display page state; mode "state" | "screenshot" | "both". Waits for the page to settle.
tab.ax.get(mode="state", opts?)                 // same, returned instead of displayed: string | screenshot | {state, screenshot}
tab.ax.click(target, {mouseButton?, clickCount?, key?, duration?}?)   // target = element index or [x, y] (CSS px, viewport)
tab.ax.setValue(i, value)                       // fill text field / choose option / set slider
tab.ax.typeText(i | null, text)                 // null = current focus
tab.ax.paste(i | null, text, {format?: "text"|"md"|"html"}?)
tab.ax.pressKey(i | null, key, {duration?}?)    // xdotool keys: "Return", "Tab", "Escape", "Up", "super+a", "shift+Tab", "KP_0"
tab.ax.scroll(target, "up"|"down"|"left"|"right", pages=1)
tab.ax.selectText(i, text, {prefix?, suffix?, selectionType?: "text"|"cursor_before"|"cursor_after"}?)
tab.ax.performSecondaryAction(i, action)        // only names listed in the element's "Secondary Actions"
tab.ax.drag(from, to) / tab.ax.hover(target)
Actions return nothing; call tab.ax.write() afterwards to see the result.

tab.playwright (Playwright-style locators; selectors resolved by Playwright's engine, input is real CDP):
pw.locator(sel) / getByRole(role, {name, exact, checked, expanded, level, ...}) / getByText(t, {exact}) / getByLabel / getByPlaceholder / getByAltText / getByTitle / getByTestId   // t: string | RegExp
pw.frameLocator("iframe#x").getByRole(...)       // any frame, incl. cross-origin
locator: .locator(sel, {hasText, has}) .filter({hasText, hasNotText, has, hasNot, visible}) .first() .last() .nth(i) .and(l) .or(l) .all()
actions (auto-wait for visible/enabled/editable; strict: must match exactly one; default timeoutMs 3000):
  click({button, clickCount, modifiers, position, force, timeoutMs}) dblclick hover fill(v) clear() type(v) pressSequentially(v) press("Enter"|"Control+A")
  check() uncheck() setChecked(b) selectOption(v | {value|label|index} | [...]) selectText() setInputFiles(paths) waitFor({state: attached|detached|visible|hidden})
queries: count() isVisible() isEnabled() textContent() innerText() innerHTML() inputValue() getAttribute(n) allTextContents() allInnerTexts()
  evaluate((el, arg) => …, arg)                   // page main world; evaluateAll((els, arg) => …) runs in an isolated world
  downloadMedia({path?, directory?}) → saved file path (img/video/audio/link, fetched with the page's cookies)
page: pw.domSnapshot() → Playwright aria snapshot (YAML, iframes expanded) with [ref=e12]/[ref=f1e3]; act on refs with pw.locator("aria-ref=e12")
  pw.elementInfo({x, y, includeNonInteractable?}) → interactable elements at a screenshot point (topmost first, iframes entered): {tagName, role, ariaName, visibleText, boundingBox, selector: {primary, candidates, frameSelectors?}}
  pw.elementScreenshot({x, y, includeNonInteractable?}) → {data, mimeType, elements}: viewport JPEG with those elements' boxes numbered and the point marked; display(shot) to see it
  pw.evaluate(fn, arg) · pw.waitForLoadState({state})
  pw.waitForURL(url | glob "**/x?**" | RegExp) · pw.expectNavigation(() => action, {url, waitUntil}) · pw.waitForTimeout(ms)
  const fc = pw.waitForEvent("filechooser"); await pw.getByText("Upload").click(); await (await fc).setFiles(["/abs/file"])
  const dl = pw.waitForEvent("download"); await pw.getByText("Export").click(); await (await dl).path()

AX state text: header with tab title + URL, then one line per element "<index> <role> (<flags>) <name>, <Key>: <value>", indented by nesting. Later writes return a diff (removed ids, "~" changed and "+" added lines) or a one-line "no change" note. Indices are stable across diffs and never reused.

Example:
const tab = await browser.tabs.new("https://example.com");
await tab.ax.write();
// next call
await tab.ax.setValue(12, "jelly");
await tab.ax.pressKey(12, "Return");
await tab.ax.write();`;

export const BROWSER_GUIDANCE = `## Connected Chrome (browser_js)
- Name the session first: \`await browser.nameSession("🔎 <short task>")\`, then open (\`browser.tabs.new(url)\`) or claim tabs. Reuse REPL handles; don't redeclare or reacquire tabs unless they are stale (after a REPL reset).
- Observe with \`await tab.ax.write()\`. Batch as many actions as possible plus one final \`tab.ax.write()\` into a single browser_js call. Actions don't need sleeps; write() waits for the page to settle.
- Prefer AX element indices over coordinates, and re-derive indices from the latest state after acting. Use coordinates (from a screenshot) only when AX actions don't work.
- tab.ax is the most efficient for short or non-repetitive tasks. Use tab.playwright locators when they let you batch many steps into one call: long repetitive work where indices churn, loops over list rows, forms you fill field by field, or sites you're developing whose structure you know. Locators are more verbose to write, so only use them when they save tab.ax.write() round trips.
- Diffs are the default; trust them. Use \`tab.ax.write("state", {disableDiffing: true})\` only when you need the full tree, \`write("screenshot")\` for visual-only context, \`write("both")\` rarely. Don't repeat write() with no action in between after a "no change" result.
- If an action has no effect, look for the blocker in the state (dialog, overlay, disabled control, focus) before retrying; don't blindly repeat or jump to coordinates.
- Don't goto the URL a tab is already on (it reloads and loses input); use tab.reload() when you mean it. The AX header already has title and URL.
- Lookups: one focused direct URL (result page or parameterised search) is fine; don't iterate guessed URL variants or rewrite search queries in loops. Once one authoritative signal answers the question (selected option, success toast, basket line, URL param), stop verifying and answer.
- Base "first"/"top" on visible state, not DOM order. When the task is done, stop exploring.
- Logins: you may type credentials you were given (or that are available to you) into login forms with tab.ax.setValue/typeText, and enter OTP codes. You may solve CAPTCHAs (checkboxes, image grids, sliders) with normal clicks and screenshots like any other element. request_browser_login is an optional handoff when you lack the credentials or need the user's 2FA device.
- User tabs: \`browser.user.openTabs()\` lists the user's tabs; pick by title, URL, recency and group, then \`browser.user.claimTab(thatObject)\` and use the returned Tab. Only claim ids from the current openTabs() result; if a referenced tab is gone or changed, say so instead of claiming another.
- Tab cleanup: unmarked agent tabs close at turn end; unmarked claimed tabs are released and left open. \`tab.markDeliverable()\` when the live tab is the result the user should keep (edited doc, dashboard, submitted form, page they asked to keep open). \`tab.markHandoff()\` only when work must continue from that page next turn (waiting on user input/approval/2FA). Marks are per turn: re-mark tabs that must survive again. Don't mark research, search or intermediate tabs.
- File uploads: find the file input in the AX state and \`await tab.setFiles(index, ["/absolute/path"])\`; if it is hidden, use disableDiffing to find it or locate it with tab.evaluate/tab.cdp (DOM.setFileInputFiles).
- Screenshots are JPEG. To show one to the user (proof of a completed change, or something they must approve or should see), save it and attach it with render_file: \`require("node:fs").writeFileSync("/abs/dir/shot.jpg", Buffer.from(shot.data, "base64"))\`. Showing it only in tool output doesn't count. Include screenshots the user asked for in your reply.
- A timeout restarts the REPL and clears all variables; set timeout_ms for long waits or holds.`;
