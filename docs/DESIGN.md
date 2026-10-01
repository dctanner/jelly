# Jelly design references

The requested reference is **Grok Bot**, the persistent-agent product, rather than the ordinary Grok chat interface.

Inspected screenshots from [Agent Native's Grok Bot walkthrough](https://agentnative.inc/resources/grokbot-email-and-credit-card):

- [Desktop agent sidebar and conversation](https://agentnative.inc/resources/grokbot-email-and-credit-card/step-01.png).
- [Rounded message composer](https://agentnative.inc/resources/grokbot-email-and-credit-card/step-02.png).

The [official product page](https://x.ai/bot) and [creation guide](https://docs.x.ai/grok-bot/get-started) also establish the named-agent workspace and name/job/description setup pattern.

## Applied design

- Two-pane workspace: persistent agents on the left, one conversation on the right.
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

- Use a compact, centered 17px title: **Agents** at the root, or the current project name. Keep the hamburger menu on the right and **‹ Back** on the left inside a project.
- The root contains project rows and unassigned agents, not a flat list of every agent. Project rows use a small avatar cluster, member/working counts, and an attention summary when any active member needs help. If any active member is running, show the shared spinning activity arc around only the frontmost avatar; keep the separate attention/unread indicator unchanged. Amber attention takes priority over blue unread indicators; archived members do not contribute.
- Sort by latest assistant response; a project's timestamp is its most recent active member's response. Tool calls, prompts, and status changes do not promote rows.
- Opening a project pushes horizontally to its agent list. Back reverses the slide; retain list scroll positions, per-agent drafts, and browser navigation. Keep inactive panes inert and out of the accessibility tree.
- Search is a menu action, not a permanent input. At the root it finds projects and agents across projects; inside a project it searches that project's agents. Search results route to the appropriate project/conversation. Cmd/Ctrl+K also opens search.
- Keep the 60px floating create button at the bottom right, clear of the safe area. Creation inherits the current project, or creates an unassigned agent at the root. New project, Manage project, and Add existing agent remain available through the menu.

## Default in-chat form cards

Use `ChatFormCard` and `ChatFormActions` from `src/client/ChatFormCard.tsx` for all new inline forms, approval requests, and private handoffs. Sudo and browser sign-in use this shared shell; do not create another ad-hoc intervention card or reuse a modal's focus trap in the transcript.

- Rounded page-colored card, compact icon/title/status header, and inset grouped surfaces.
- Keep the reason visible. Put long technical details in a native disclosure with a useful visible summary; privileged requests must retain the complete command and working directory for review.
- `request_sudo` requires a human-readable `summary` (1–500 characters) describing the command's actions and meaningful side effects, separately from `reason` (why it is needed). Show it inside the expanded **Review command** section, above the exact command. Keep the executable path in the collapsed row. Legacy requests without a summary retain their exact command details; do not invent descriptions for old commands.
- Wrap labeled controls in `.chat-form-field`, use `.chat-form-form` for form spacing, and connect `.chat-form-hint` privacy/help text with `aria-describedby`.
- Use `ChatFormActions` with a secondary button first and a primary submit/continue button last. Keep controls keyboard-accessible with at least 44px action targets and 16px input text on phones.
- Errors use the shell's `error` prop and an alert. Never put credentials in React state, stored transcripts, logs or persistence; clear password fields before submitting private requests.
- Do not steal focus when a card arrives. Collapse settled requests back into tool history; restore an empty, retryable form if submission fails.

## Mobile remote browser

While a person controls the remote browser in a portrait viewport up to 767px
wide, scale the desktop to fill the viewer's height and clip its sides. Place
a 44px-tall, keyboard-accessible horizontal pan slider directly above the viewer.
Panning moves only the local view; do not change the website zoom, remote screen
resolution, or touch/click coordinate mapping. Desktop, landscape, and view-only
sessions continue fitting the entire desktop. Private handoff restrictions are
unchanged. `bun run test:computer-viewport` checks this with real Chromium/VNC
using temporary data and the installed desktop dependencies.

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
