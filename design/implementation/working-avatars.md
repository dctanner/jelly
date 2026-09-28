# Laptop working avatars

Implemented 23 September 2026. Twelve individual variants generated with built-in imagegen, using each existing portrait as its edit target. The original character art remains unchanged.

- Runtime assets: `public/brand/avatars/01-jellyfish-working.png` through `12-nudibranch-working.png`.
- Exact prompts and source/destination mapping: [working-avatar-prompts.json](../brand/working-avatar-prompts.json).
- [Comparison gallery](../brand/working-avatars.html) includes ready/working pairs and previews at 28, 40, and 48 px.
- Live agent rows, chat header, and activity indicator select the laptop portrait only when agent status is `running`. Idle, waiting, stopped, and failed states use the regular portrait. Existing text status and reduced-motion behavior remain in place.
- Historical message avatars and avatar selection stay on the original portraits.
- No new persisted field or server API: the existing live snapshot/SSE status drives the switch.

Validation: TypeScript, 14 client tests, and production build pass. The existing real-run client integration test verifies the selected creature's working portrait in all three locations and restoration after completion. Browser review verified all three images loaded and stopping restored the regular portrait. Desktop 1440×960 and mobile 390×844 screenshots are in the [implementation gallery](../screens/implemented/index.html), captured from a disposable sample instance using an actual demo run.

Reproduce the busy preview with `bun run build` then `bun scripts/design-preview.ts --working`. This deliberately slows the isolated demo, leaving the user's `.jelly` data untouched.
