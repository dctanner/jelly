export const PEEKABOO_INSTALL = "brew install openclaw/tap/peekaboo";
export const PEEKABOO_URL = "https://github.com/openclaw/Peekaboo";

export interface DesktopPermission {
  name: string;
  granted: boolean;
  instructions?: string;
}
export interface DesktopStatus {
  enabled: boolean;
  platformSupported: boolean;
  installed: boolean;
  version: string | null;
  permissions: DesktopPermission[];
}

export const DESKTOP_INSTRUCTIONS = `Native Mac control: when the peekaboo tool is available you have full control of this Mac through the Peekaboo CLI. Pass CLI arguments to the tool (for example ["see","--app","Safari","--json"], ["click","--on","B1"], ["type","hello"], ["app","launch","Notes"]). Run ["learn"] once for the complete usage guide. Screenshots written by commands are attached to the result.`;
