# Mobile inputs and overlays: remaining device validation

Implementation is complete. See the [delivery record](../plans_done/mobile-input-and-overlays.md) and [design rules](../docs/DESIGN.md).

Automated layout fixtures cover 320, 375, 390, 430, 768, 844, and 1280px widths, idle/running controls, full-width drafts, the 25% conversation reserve, long notices, popup containment, simulated keyboard geometry, and rotation. Native Safari keyboard/picker behavior is not established by Chromium emulation.

## Real iPhone Safari and installed PWA

- [ ] Focus Queue/Steer, model/effort, search, profile/project fields, folder creation, uploads, clipboard, and in-chat inputs: no automatic zoom. Confirm intentional pinch zoom still works.
- [ ] Open and close the keyboard and native select pickers. Verify the model/effort sheet, other modals, and their dismissal/actions remain reachable.
- [ ] Rotate with a popup open; check landscape safe areas and browser toolbar expansion/collapse.
- [ ] Type/paste a long draft while idle and running. Text should use the entire inner width above the toolbar, with at least one quarter of the visible viewport showing conversation below the header.
- [ ] Check long paths/errors and large inline cards: no horizontal page overflow; content and actions remain reachable by scrolling.

No server or persistence changes are required. Use the queued idle-restart procedure in `AGENTS.md` for activation, then verify loopback and Tailscale HTTP access. Do not restart inline from an agent run.
