import { chromium } from "playwright-core";
const child = Bun.spawn(["/usr/bin/python3", "tests/connected-chrome-os-auth.py"], {
  env: { ...process.env, JELLY_AUTH_BROWSER_FIXTURE: "1", JELLY_FIXTURE_BROWSER: chromium.executablePath() },
  stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
