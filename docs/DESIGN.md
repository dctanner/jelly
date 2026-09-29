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

The default follows the OS preference. Users can choose Light, Dark, or System in Connection & appearance, or use the sun/moon shortcut. Their preference persists in browser storage. System mode responds to OS theme changes.

Both themes share layout and spacing tokens. Narrow screens collapse the sidebar to agent initials while retaining agent selection, creation, settings, and theme controls. Inputs and icon buttons have accessible names; native dialogs supply modal focus behavior and Escape dismissal. Product animations remain enabled independently of the OS Reduce Motion preference.

## Default in-chat form cards

Use `ChatFormCard` and `ChatFormActions` from `src/client/ChatFormCard.tsx` for all new inline forms, approval requests, and private handoffs. Sudo and browser sign-in use this shared shell; do not create another ad-hoc intervention card or reuse a modal's focus trap in the transcript.

- Rounded page-colored card, compact icon/title/status header, and inset grouped surfaces.
- Keep the reason visible. Put long technical details in a native disclosure with a useful visible summary; privileged requests must retain the complete command and working directory for review.
- `request_sudo` requires a human-readable `summary` (1–500 characters) describing the command's actions and meaningful side effects, separately from `reason` (why it is needed). Show it inside the expanded **Review command** section, above the exact command. Keep the executable path in the collapsed row. Legacy requests without a summary retain their exact command details; do not invent descriptions for old commands.
- Wrap labeled controls in `.chat-form-field`, use `.chat-form-form` for form spacing, and connect `.chat-form-hint` privacy/help text with `aria-describedby`.
- Use `ChatFormActions` with a secondary button first and a primary submit/continue button last. Keep controls keyboard-accessible with at least 44px action targets and 16px input text on phones.
- Errors use the shell's `error` prop and an alert. Never put credentials in React state, stored transcripts, logs or persistence; clear password fields before submitting private requests.
- Do not steal focus when a card arrives. Collapse settled requests back into tool history; restore an empty, retryable form if submission fails.
