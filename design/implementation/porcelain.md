# Porcelain implementation

Implemented in the existing React components and styles, based on the approved Porcelain concept.

- Native system typography, white and grouped-gray surfaces, blue actions, neutral dark mode.
- Fully rounded buttons, inputs, project rows, and composer; circular icon controls.
- Floating agent identity, back button, and options. The conversation scrolls behind the header. A masked 16px backdrop blur feathers into clear content and becomes fully opaque in the current background color at the top edge.
- No project switcher in the conversation header. Project switching remains in the sidebar; the details sheet shows the selected agent’s actual project, independently of the sidebar scope.
- Mobile inbox uses an Agents heading and hides the Jelly logo. Working portraits and animation remain intact.
- Agent details preserve Computer, Edit profile, Move to project, and Archive actions.

## Verification

- Full check: type checking, 30 server tests, 17 client tests, 2 capability tests, and production build passed.
- After the final header changes: type checking, all 17 client tests, and production build passed again.
- Added a regression check for floating identity actions and actual project context in details, with no project switcher in the conversation header.
- Browser review at 1440 × 960, 390 × 844, and 360 × 640; no horizontal overflow. Verified project switching, details, model menu, working portraits, and light/dark rendering.
- Screenshots use a disposable demo workspace, not the user’s agent conversations.

Review: [screenshot gallery](../screens/porcelain/index.html).

## Bottom conversation fade

The composer now overlays the conversation, with the same masked backdrop blur as the header mirrored upward. The fade reaches the current background color at the bottom edge. Its full-width layer is confined to the chat pane, while the input retains its existing desktop width. A measured composer inset reserves enough scrolling space to reveal the latest message, including when drafts grow or an error/archived notice is shown.

Validated mobile light/dark and desktop containment, multiline growth/shrink, capped long drafts, model menu visibility, and zero document scroll. Type checking, all 17 client tests, and the production build passed.
