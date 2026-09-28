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

Both themes share layout and spacing tokens. Narrow screens collapse the sidebar to agent initials while retaining agent selection, creation, settings, and theme controls. Inputs and icon buttons have accessible names; native dialogs supply modal focus behavior and Escape dismissal. The interface respects reduced-motion preferences.
