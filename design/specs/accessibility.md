# Accessibility and responsive behavior

- Use native buttons, inputs, selects and dialogs. Each icon action has an accessible name. Sea art is decorative when accompanied by an agent name.
- Dialogs trap focus through native `showModal`, close with Escape, and return focus to their trigger. Project quick-switch invoked by keyboard focuses search; pointer invocation does not force a mobile keyboard. Arrow keys cycle project choices; Enter activates; IME composition is ignored by shortcuts.
- Primary touch targets are at least 44 px. Mobile uses full-width list and chat pages; inactive content is inert. A compact action menu avoids crowding the chat header.
- Text is 16 px for body/fields and paths wrap. Desktop reading column stays near 720 px. Folder confirm controls remain visible at the bottom of the mobile sheet. Layout uses dynamic viewport height and safe-area padding.
- Status is communicated with words, not colour alone. Errors use alert semantics; working and navigation changes are announced politely. Credentials continue to use private existing controls.
- Every transitions.dev recipe retains its reduced-motion guard. Jelly float, bubbles, status pulse, and decorative bob are disabled by the OS reduced-motion preference. Reduced motion keeps static working/status text.
- Both light and dark themes use semantic foreground/background pairs. Preserve the blue action's own contrasting text token; don't use brand cyan for small body text.
- Verification is a browser/code review and automated interaction suite, not a claim of a formal WCAG audit or physical-device keyboard certification.
