# Jelly design references

The requested reference is **Grok Bot**, the persistent-agent product, rather than the ordinary Grok chat interface.

Inspected screenshots from [Agent Native's Grok Bot walkthrough](https://agentnative.inc/resources/grokbot-email-and-credit-card):

- [Desktop agent sidebar and conversation](https://agentnative.inc/resources/grokbot-email-and-credit-card/step-01.png).
- [Rounded message composer](https://agentnative.inc/resources/grokbot-email-and-credit-card/step-02.png).

The [official product page](https://x.ai/bot) and [creation guide](https://docs.x.ai/grok-bot/get-started) also establish the named-agent workspace and name/job/description setup pattern.

## Applied design

- Agents destination uses a two-pane workspace: persistent agents on the left, one conversation on the right. Apps is a separate first-class launcher destination.
- Simple agent identity at the top; no chat-thread sidebar.
- Neutral surfaces, subtle dividers, compact controls, and a rounded bottom composer.
- Colored agent avatars and understated status indicators.
- Inline tool activity, with details disclosed on demand.
- No marketing sections or nonfunctional controls for later-phase features.
- Jelly uses its own name and initial avatars; the reference screenshots are research links and are not bundled as product assets.

## Appearance and accessibility

The default follows the OS theme preference. Users can choose Light, Dark, or System in Settings, or switch Light/Dark from the agent-list menu. Their preference persists in browser storage. System mode responds to OS theme changes.

Both themes share layout and spacing tokens. Narrow screens use a full-width inbox and push into the selected conversation. Inputs and icon buttons have accessible names; native dialogs supply modal focus behavior and Escape dismissal. Product animations remain enabled independently of the OS Reduce Motion preference.

## Agent inbox and project navigation

- Use a compact, centered 17px title: **Agents** at the root, or the current project name, including mobile. Keep the hamburger menu on the right and **‹ Back** on the left inside a project.
- The root contains project rows and unassigned agents, not a flat list of every agent. Project rows use a small avatar cluster, member/working counts, and an attention summary when any active member needs help. If any active member is running, show the shared spinning activity arc around only the frontmost avatar; keep the separate attention/unread indicator unchanged. Amber attention takes priority over blue unread indicators; archived members do not contribute.
- Sort by latest assistant response; a project's timestamp is its most recent active member's response. Tool calls, prompts, and status changes do not promote rows.
- On desktop, hovering or keyboard-focusing an agent row reveals a small trailing Archive button without opening its conversation. Disable it while disconnected, archiving, or the agent is running/waiting; mobile keeps archiving in agent options.
- Opening a project pushes horizontally to its agent list. Back reverses the slide; retain list scroll positions, per-agent drafts, and browser navigation. Keep inactive panes inert and out of the accessibility tree.
- Search is a menu action, not a permanent input. At the root it finds projects and agents across projects; inside a project it searches that project's agents. Search results route to the appropriate project/conversation. Cmd/Ctrl+K also opens search.
- Keep the 60px floating create button at the bottom right, clear of the safe area. Creation inherits the current project, or creates an unassigned agent at the root. New project, Manage project, and Add existing agent remain available through the menu.

## Apps navigation, launcher and viewer

Apps (`/apps`) and Agents are first-class destinations. Restore the last destination on ordinary visits, without moving existing users out of Agents unexpectedly; explicit app/conversation links take precedence. Switching retains chat drafts, selected project/agent, scroll, unread counts and active work. Users request new apps in ordinary chat; Apps has no separate build button or creation wizard. **Edit with agent** selects/creates the appropriate normal conversation with an unsent editing draft for an existing registered app, never silently starting a model request.

On mobile, the shared Apps/Agents switcher sits at the bottom in an iOS-style navigation bar with a subtle top inner shadow. At desktop widths (768px and above), it sits at the top of the persistent sidebar rail, above the existing Agents inbox; Apps content occupies the main pane to the right. The rail follows the existing 280px/304px sidebar widths. Its segmented control keeps one rounded track, a raised current-page thumb and 44px links. Mobile navigation owns the home-indicator inset; desktop sidebar navigation owns its top inset. Lists, creation controls and the composer stay clear of navigation. Apps uses a large system-font title, tinted Add app capsule, and filled magnifier search field rather than a web-form label/button treatment or inherited chat-header padding. Launcher icons use continuous corners where supported, with rounded-corner fallback; independent star/overflow controls stay quiet but always visible. History uses inbox-style inset separators and can share two columns on wide screens without changing chronological DOM order.

Keep the Apps and Agents destination titles visible on mobile and desktop, along with contextual project/conversation titles. Desktop navigation precedes the workspace in DOM/tab order; mobile navigation follows it. Resizing must preserve mounted workspace state and drafts. Mobile conversations hide the footer switcher and reclaim its height; Back returns to the inbox and restores the tabs. Only chat entries owned by the current mounted workspace are popped; direct links and reloads return to the inbox within the document so drafts are not discarded. Apps and the mobile inbox retain the switcher, and desktop sidebar navigation remains visible in chat. The app viewer hides the Agents/Apps sidebar and footer switcher, replacing them with a bottom app-navigation bar at every viewport width. Keyboard-sized chat viewports must keep the composer reachable.

Apps registration, details and editor sheets reuse the grouped Settings language: name/URL inputs, inset About rows, explicit icon actions, native select rows, readable disclosure groups, and a keyboard-focusable icon picker. Registration shows the concise trusted-app cookie notice. Removal explains that metadata, stars and history are removed while the independent service/source/data are untouched; place the primary action above Cancel. Technical labels stack above values on narrow phones. Context menus have trailing symbols, clear group separators and a red Remove action. Viewer chrome uses the shared bottom navigation surface: a back chevron, horizontally scrollable app-name segments with the current app highlighted, and the existing app-actions menu. The bar reserves its own height instead of covering app content; recovery screens retain retry/edit and compatibility guidance, never alternate launch modes.

Home has **Starred** above **History**, with lightweight search across both:

- Starred uses spacious rounded-square icons and short names, three columns on narrow phones, ordered by `starredAt` descending with a stable ID tie-breaker. Launches, renames and health updates do not reorder it.
- Unstarred History uses compact rows ordered by `COALESCE(lastOpenedAt, createdAt)` descending with a stable ID tie-breaker. Show relative last-opened time or “Not opened yet”; paginate history. Starred apps are not duplicated here.
- New apps are unstarred. Opening records launch intent once per navigation and immediately promotes a history row; metadata edits, prefetches and internal iframe routes are not visits. External bookmarks are not tracked.
- A separate 44px **Star/Unstar** toggle exposes `aria-pressed`, works without launching, retains focus across section movement and announces changes. Starring is idempotent; unstar/re-star receives a new timestamp. On failure restore the saved state and offer retry. Registration edits preserve stars and visits.
- A separate accessible overflow offers Details, Edit with agent and Remove from Apps. Details retains editable name/URL/description, icons and useful project/builder/source attribution. No service status, health observations or lifecycle controls are shown; Jelly does not own hosting.


With no stars, show “Star apps to keep them here” above History, not an empty grid. Omit empty History when only starred apps exist. The fully empty state reads “Your apps live here. Add a trusted app to get started.” Unavailable apps keep their position and open a useful recovery screen rather than a blank error.

`/apps/:id` renders the direct registered URL in an iframe filling the space above the bottom app-navigation bar, without an agent sidebar or composer. The bar uses the same segmented styling as Agents/Apps: **‹ | App 1 | App 2**, plus the app-actions menu. Back has an accessible **Back to Apps** name and a minimum 44px target, explicitly returns to `/apps`, restores Home scroll and focuses the originating tile/row by app ID, never `history.back()`. App-name links include all registered apps, paginate the registry, and sort alphabetically so opening an app does not move its tab. Selecting the current app does not reload it or record another visit. Overflow scrolls horizontally while Back and the actions menu stay reachable. The bar owns the bottom safe-area inset at all viewport widths, survives loading/failures/internal routes, and never overlays the embedded app. Corner preferences are no longer shown. No app bridge, home-link handshake, viewer deep-route persistence, SDK, new-tab mode or proxy is required or offered.

Allow scripts, forms, same-origin app storage/cookies and downloads; streaming/WebSockets connect directly to the app. Deny top navigation, popups and privileged camera/microphone/fullscreen permissions where practical. These restrictions are not isolation guarantees. Owner-trusted same-host apps can receive or interfere with Jelly cookies, including HttpOnly cookies at their servers. Tailscale provides private network access, not per-app isolation. Registering a URL grants no control API privileges, and Jelly itself remains unframeable.

Iframe load is not proof of rendering; cross-origin failures cannot always be diagnosed. Show useful help for app uptime/device access, target CSP frame-ancestors/X-Frame-Options, HTTPS Jelly versus HTTP app mismatch, framed login/third-party cookies, and localhost on phones. Preserve target security headers, offer retry/edit, and never add an alternate direct-launch fallback. No general compatibility or real Safari/phone verification is implied. See [Apps](APPS.md).

## Model and effort scope

- The composer switcher shows the current agent’s saved model and effort. A change updates that agent and the defaults for agents created afterward, never other existing agents.
- Settings labels its model/effort group **New agent defaults**. Changes there do not update existing agents; connection mode remains instance-wide.
- Changes take effect on the selected agent’s next run. Active runs retain their captured settings; new subagents inherit that run’s settings, and resumed subagents retain their persisted model and effort.
- On phones, model/effort opens in the shared bottom sheet and focuses its heading, not a native select. Wider layouts keep an anchored popup with trigger focus and logical Tab/Escape navigation. Reset it when changing agents.

## Mobile controls, overlays, and composer

- Editable controls and selects use at least 16px text on narrow or touch layouts, including landscape phones, to avoid iOS focus zoom. Preserve larger inherited text and intentional pinch zoom; never disable user scaling.
- The composer always has a full-width textarea above its button toolbar. Keep 44px actions, wrapping the toolbar when necessary rather than stealing text width or shrinking control text.
- Growing drafts reserve at least one quarter of the current visible viewport for conversation below the header. Count toolbar, notices, padding, and safe areas in the composer budget. Long drafts scroll inside the textarea; exceptionally short viewports or tall notices make the bounded wrapper scroll as well.
- Shared modal shells use visual-viewport bounds, including keyboard offsets and safe areas. Keep headings/dismissal reachable and scroll long bodies. Inline `ChatFormCard` content stays in transcript flow, with shrinkable columns and wrapping paths/errors.
- Anchored menus use `useAnchoredPopover` and body portals to escape transformed/clipping ancestors. Flip and shift into safe viewport bounds and keep their focus/outside-click handling portal-aware.
- `bun run test:mobile-layout` checks isolated browser layouts at 320–1280px, with running/idle controls, long drafts/notices, keyboard geometry, and rotation. This does not replace real iPhone Safari/PWA verification of native focus zoom and keyboard behavior.

## Directory selection and creation

- New project and file upload dialogs provide **New Directory** alongside their folder-browsing controls. The shared folder picker offers the same action.
- Create a single named directory inside the displayed parent, then enter it and offer **Use this folder**. Preserve the project name and selected upload files while choosing a destination.
- Keep creation inline in the picker, with a labeled name field, Cancel/Create actions, and visible retryable errors. Do not overwrite existing entries or create missing parents. Disable navigation and dismissal while creation is in progress.

## Default in-chat form cards

Use `ChatFormCard` and `ChatFormActions` from `src/client/ChatFormCard.tsx` for all new inline forms, approval requests, and private handoffs. Sudo and browser sign-in use this shared shell; do not create another ad-hoc intervention card or reuse a modal's focus trap in the transcript.

- Rounded page-colored card, compact icon/title/status header, and inset grouped surfaces.
- Keep the reason visible. Put long technical details in a native disclosure with a useful visible summary; privileged requests must retain the complete command and working directory for review.
- `request_sudo` requires a human-readable `summary` (1–500 characters) describing the command's actions and meaningful side effects, separately from `reason` (why it is needed). Show it inside the expanded **Review command** section, above the exact command. Keep the executable path in the collapsed row. Legacy requests without a summary retain their exact command details; do not invent descriptions for old commands.
- Wrap labeled controls in `.chat-form-field`, use `.chat-form-form` for form spacing, and connect `.chat-form-hint` privacy/help text with `aria-describedby`.
- Use `ChatFormActions` with a secondary button first and a primary submit/continue button last. Keep controls keyboard-accessible with at least 44px action targets and 16px input text on phones.
- Errors use the shell's `error` prop and an alert. Never put credentials in React state, stored transcripts, logs or persistence; clear password fields before submitting private requests.
- Do not steal focus when a card arrives. Collapse settled requests back into tool history; restore an empty, retryable form if submission fails.

## Computer control and Connected Chrome

Settings and every agent menu open the same `ComputerControlPanel`: global human
computer access, not an agent/browser ownership transfer. Use **Take control**,
**Done**, and relevant reconnect/cleanup retry. Keep browser profile/site access
in separate Connected Chrome settings. A contextual, collapsed Advanced section
may close that agent’s idle browser session for recovery; it is not computer
ownership. Agent context must preserve its pinned
computer; never silently choose a different desktop or route to native Mac
automation controls. The global entry works without a selected agent.
If a global configured browser is disconnected, an explicit **Use installed
computer** choice may expose the installed desktop; never silently change an
agent’s pinned target.

Explain concisely that this is the full computer (other windows and notifications),
text transfer is human-initiated only (no files), and browser agents may continue.
Use **Paste to computer** / **Copy from computer** with a compact **Text options**
disclosure for manual textareas, send-only and terminal paste. Say “this device”
and “computer”, not protocol jargon. Clipboard APIs run only in explicit gestures;
real viewer paste events use their supplied text. Reject unsupported/oversized
text without truncation, never paste after a stale connection, and clear local
transfer fields on disconnect/Done. Clipboard managers may retain native text;
never promise erasure. Keep touch targets at least 44px and manual input at 16px.
Human-use status is
advisory, never a privacy-lock promise. Sign-in Done completes only the bound
request. No local “Open in Chrome”, pause/resume or tab-capability controls.

On portrait phones (up to 767px), fill the viewer's height and provide a
44px-touch-target **Pan** slider above it to reach both horizontal edges.
Use the actual framebuffer aspect ratio, not a fixed managed-browser resolution.
Landscape and desktop views fit the whole desktop. Do not change website zoom,
framebuffer resolution or input mapping; noVNC owns scale and pointer conversion.
Leaving the canvas for Pan releases held viewer keys through noVNC before local
input, without global blur or replay into a replacement canvas. Panning resets
after disconnect/Done and never reconnects. Keep clipboard controls outside the
clipped viewport.
While connected on phones, use a compact 44px header and one row of 44px
keyboard, paste, copy, text-options, information and Done controls. Icon-only
controls keep accessible names and titles. Show the full access notice before
Take; keep it available behind the information button while connected. Hide
nonessential status/Advanced chrome only in this active mobile layout.
The viewer fills the remaining visible viewport, including soft-keyboard resize;
reserve the pan row when calculating overflow to avoid resize oscillation.

**Show keyboard** focuses an in-viewport input synchronously from the gesture.
Remote pointer taps keep that input focused. Send only committed Unicode text
and balanced key pairs; never retain typed text in React state, logs or storage.
Discard composition on hide, blur, disconnect or Take change, and never send
late input to a replacement viewer. Provide Esc, Tab and arrow buttons; Escape
hides the local keyboard and Shift+Tab returns to local controls. Keep clipboard
paste in the explicit transfer controls, not the keyboard input.
Closing an owned viewer stops
input and sends Done; cleanup errors remain retryable but must not trap dismissal
or block browser tools. Never release another control session’s viewer. Preserve
native cleanup/authentication protections. Bind actions to the displayed Take,
not a newer viewer fetched in the background. See [Connected Chrome](CONNECTED-CHROME.md).

## Agent identity editing

Before the first message, show a single centered identity pill. Its name and avatar
are separate keyboard-accessible controls: the name becomes a transparent, borderless
in-place input with identical typography and no action buttons. Blur saves (Enter
blurs the input, Escape cancels), and the avatar opens a full-height
grid below it, with every avatar visible without internal scrolling, without a title, cancel button, or modal. Selecting an avatar saves
and closes the grid; Escape or clicking outside dismisses it. Keep the pill visible above the picker
on phones. The compact name field deliberately stays inside the pill rather than
introducing a second card. Sending waits for a name edit/save to finish.

After conversation begins, the header pill opens the full profile edit form
directly; the ellipsis still opens agent actions. The form can be viewed while
working but remains read-only until the agent is idle and connected. Avatar-only
edits must not opt out of first-message naming or overwrite other profile fields.

`bun run test:agent-identity` exercises these transitions in isolated Chromium
fixtures at desktop and two phone widths, with no real model requests.
