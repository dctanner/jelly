# Jelly — Familiar, with a little ocean

Logo direction superseded: use a regular lowercase “jelly” wordmark with an ordinary j. See the newer [standalone jellyfish logo explorations](../jelly-logo-variations/README.md). The avatar and motion studies below remain available.

This develops approved direction 01. All artwork was generated with built-in ImageGen. These are design proposals and a small interactive motion study; the running application's source and agent settings have not been changed.

## Deliverables
- [Desktop + mobile concept](familiar-sea-final.png)
- [Jellyfish-j logo exploration](logo-final.png)
- [Twelve-avatar contact sheet](avatar-collection.png)
- [Interactive avatar chooser](gallery.html) — selection changes the local preview only.
- [Working animation preview](motion-preview.html)
- [Complete generation prompts](prompts.md)

## Brand
The lowercase j doubles as a jellyfish: its dot becomes the bell, its stem the longest tentacle, and the hooked descender keeps the word legible. The rest of the wordmark stays simple. The image is a raster identity proposal, not a production vector master. Final optical spacing and small-size simplification should happen during vector production.

Primary blue #1672F8, ink #172B47, icy surface #F5F9FF. Sea-creature colors belong mainly to avatars; reading surfaces stay white.

## Agent avatar family
Twelve separate original PNGs, all in avatars/. The actual generated collection is shown in the contact sheet and chooser; the image-generated UI board contains illustrative approximations.
1. Jellyfish — default Jelly identity
2. Octopus
3. Whale
4. Sea turtle
5. Crab
6. Pufferfish
7. Seahorse
8. Manta ray
9. Starfish
10. Seal
11. Clownfish
12. Nudibranch (Sea slug)

Each has a softly shaded pastel portrait with a distinctive silhouette. The gallery shows circular crops and a 42px chat-size preview. Original full-resolution PNGs are retained; optimized sizes can be derived at implementation time.

## Motion
The inline prototype uses a simple code-native jellyfish interpretation, not a warped raster avatar. A 2.8-second gentle float/pulse and staggered tentacles communicate activity. A tiny bubble appears occasionally. Keep it beside the assistant's reply position so the layout stays stable. It is a working indicator, not a progress percentage.

Stop/replay and reduced-motion controls are interactive. Motion stops while idle; prefers-reduced-motion makes the creature static while the status text remains. The reduced-motion checkbox lets the design be inspected manually. The preview is self-contained and does not call the agent or send a chat message.

## Small sea details
Visible in concept:
- A faint wave contour at the sidebar footer, away from message content.
- One occasional bubble beside the working jellyfish.
- Sea-creature portraits bring most of the playfulness.

Additional Easter egg proposals, not implemented:
- Tapping the wordmark releases two bubbles once; respect reduced motion and a cooldown.
- An avatar gives one tiny bob after selection, with a static selected ring and checkmark remaining.
- A single quiet seashell in the empty archive illustration. Keep the label “Archived agents” and the explanatory copy plain.
- A brief jellyfish blink after a successful reconnect; preserve explicit Connected/Disconnected text.

Avoid continuous background waves, floating decorations over messages, sound, nautical names for ordinary commands, and celebratory motion during errors or approvals.

## Review
The avatar chooser was opened and its selection update checked. The working preview was opened at desktop and mobile sizes, its stop/replay state and reduced-motion flag checked. This is visual design validation, not integration testing of the running app.
