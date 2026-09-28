# Jelly: three design directions

Created with the built-in imagegen tool after browsing the running app at http://127.0.0.1:5173. These are visual proposals with illustrative agents and conversation content; application source was not changed.

## Original app

Local-instance captures are omitted from the public repository. The original mobile layout had a narrow permanent sidebar, a cramped header, and horizontal overflow.

## Proposals
Each board includes desktop sidebar/chat, mobile navigation and mobile chat.

1. [Familiar](01-familiar.png): Messages-inspired inbox rows, previews, blue unread dots, blue user bubbles and a full-screen mobile inbox. Most familiar interaction model.
2. [Quiet](02-quiet.png): restrained warm neutrals, readable assistant prose, a compact composer and an on-demand mobile drawer. Recommended foundation for everyday use.
3. [Soft Signal](03-soft-signal.png): lilac agent navigation, pinned agent shortcuts, white chat canvas and rounded controls. Strongest Jelly-specific identity; pinned shortcuts should appear only when useful rather than duplicate a short list.

## Shared behavior to carry into implementation
- Desktop keeps agent navigation visible; mobile conversation uses the whole screen.
- Mobile navigation is a separate inbox or dismissible drawer.
- Keep tool details collapsed and secondary to the answer.
- Preserve connection settings, Computer access and agent management.
- Keep composer above keyboard and safe area; long content must wrap.
- Retain a compact model selector through the composer menu or header; the boards do not detail every existing setting.
- Status must remain understandable through text and icons, not color alone.
- Prototype keyboard, focus, drawer transitions and long conversations before implementation approval. Generated boards are not interaction-tested.

## Screenshot references
- [Apple Messages guide](https://support.apple.com/en-gb/guide/iphone/iph82fb73ba3/ios) — list hierarchy, avatars, message previews, search and unread indicators. Third-party screenshot not redistributed.
- [ChatGPT iOS sidebar screenshot](https://new.atsit.in/pl/posts/1391020575/) — search, simple grouped navigation and separation between drawer and chat. Third-party screenshot not redistributed. This is a historical visual reference, not a claim about the latest app.
- [Official ChatGPT iOS introduction](https://openai.com/index/introducing-the-chatgpt-app-for-ios/).

Full generation prompts: [prompts.md](prompts.md).

