# Mac control (Peekaboo)

Agents can control the Mac that Jelly runs on using
[Peekaboo](https://github.com/openclaw/Peekaboo).

## Setup

1. Install Peekaboo:

   ```sh
   brew install openclaw/tap/peekaboo
   ```

2. In Jelly, open **Settings → Tools → Native Mac desktop** and turn on
   **Let agents control this Mac**.
3. If Accessibility or Screen Recording shows as missing, click
   **Grant permissions…** and allow them in macOS System Settings.

When it's on, every agent gets a `peekaboo` tool with full access to the
Peekaboo CLI: screenshots, clicking, typing, apps, windows, menus and so on.
Screenshots from commands are attached to the tool result. Turn the switch off
to remove the tool from new runs.

See the [Peekaboo repository](https://github.com/openclaw/Peekaboo) for more
information.
