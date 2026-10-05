# Mobile controls and composer implementation

Implemented client-side:

- Minimum 16px editable controls on narrow/touch layouts; 44px composer actions. Pinch zoom remains enabled.
- Full-width composer text above a separate toolbar in idle and running states.
- A measured composer budget reserves 25% of the visible viewport below the header, including keyboard-open layouts. Long drafts scroll internally; oversized notices/short viewports use a bounded scrollable wrapper.
- Shared, keyboard-aware mobile model/effort sheet with heading focus and trigger restoration.
- Viewport-clamped, flipping desktop settings/inbox popups, portalled outside clipping ancestors with keyboard navigation and outside-click handling.
- Shared modal width/height/offset bounds, scrollable bodies, safe-area handling, and shrinkable inline form contents.
- Empty-agent avatar-picker expansion no longer follows the transcript bottom and hides the identity pill behind the taller composer.

Coverage: `tests/client.test.tsx`, `tests/mobile-layout.browser.ts`,
`tests/agent-identity.browser.ts`, and `tests/history-scroll.browser.ts`.
The mobile layout fixture uses temporary data and emulated visual-viewport
geometry; it makes no real model requests.

Verified:
- `bun run check`: typecheck, 299 tests, and production build passed. An earlier
  concurrent run hit server-test timeouts; the isolated full rerun passed.
- `bun tests/mobile-layout.browser.ts`: all 14 viewport/state combinations passed,
  including keyboard bounds and open-popup rotation.
- `bun tests/agent-identity.browser.ts`: desktop and both phone widths passed.
- `bun tests/history-scroll.browser.ts`: desktop/mobile scroll anchoring passed.
- `bun tests/computer-viewport.browser.ts`: portrait, panning, pointer mapping,
  landscape/desktop fit, and handback passed.

Real-device acceptance remains in
[the outstanding checklist](../plans/mobile-input-and-overlays.md).
