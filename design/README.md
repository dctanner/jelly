# Jelly design package

Open [the visual library](index.html) or visit `/design/` on the dev server. The production implementation lives in `src/client` and `src/server`; this folder preserves design intent and exploration.

- [Brand kit](brand/index.html): approved logo 05, regular wordmark, six logo exports, font and twelve avatars.
- [UI kit](ui-kit/index.html): semantic tokens, component specimens, light/dark foundations.
- [Screen explorer](screens/index.html): 40 fixture scenarios at desktop, tablet and mobile sizes. Fixtures illustrate behavior; they do not call the app API.
- [Implemented screenshots](screens/implemented/): real production build with disposable sample data.
- [Motion](motion/index.html): working jellyfish and interactive motion reference.
- [Implementation and verification](implementation/plan.md): source mapping, delivered behavior and test evidence.
- [Archive](archive/README.md): every earlier output, prompt, reference and superseded direction.

The app uses transitions.dev recipes for dropdowns, dialogs, Computer panels, and mobile list/chat navigation. Production timing takes precedence over the initial 180/260 ms concept timings. Source recipes are preserved in `implementation/transitions/`.
