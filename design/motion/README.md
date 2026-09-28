# Motion specification

Production source: `src/client/motion/transitions.css` and `src/client/Modal.tsx`. Public recipes from https://transitions.dev/skill.html are preserved in `../implementation/transitions/`.

| Interaction | Production implementation |
| --- | --- |
| Project dropdown | `t-dropdown`, origin top-left, 250 ms open / 150 ms close, 0.97 initial scale. Mobile origin at bottom. |
| Modal | `t-modal`, 250 / 150 ms, scale 0.96 → 1. Close remains mounted until the CSS token duration elapses. |
| Computer | `t-panel-slide`, data-open, recipe timing and translation/blur. |
| Mobile list/chat | `t-page-slide`, pages 1/2, recipe transitions. Inactive page inert, container clips overflow. Desktop overrides spatial page motion. |
| Working jelly | 2,800 ms float, ≤3 px travel, subtle breathing. Single faint bubble every 4,800 ms. Only while actively running. |
| Waiting | Static mark and explicit waiting text. |
| Brand Easter egg | One 280 ms bob after user taps the brand mark. No automatic celebrations. |
| Disclosure | Chevron rotates with the shared fast token. |

Use transform/opacity for regular spatial transitions. Never animate chat content repeatedly on every SSE refresh. All recipes and decorative loops stop with `prefers-reduced-motion: reduce`; labels remain. The original design motion sandbox uses earlier concept timings and is a reference, not the production source of truth.
