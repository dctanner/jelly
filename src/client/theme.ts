import { useEffect, useState } from "react";
export type Theme = "system" | "light" | "dark";
export function readPreference(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Browser preferences can be disabled. */
  }
}
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = readPreference("jelly.theme", "system");
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [resolved, setResolved] = useState<"light" | "dark">("dark");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const value =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = value;
      document.documentElement.style.colorScheme = value;
      document
        .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute("content", value === "dark" ? "#111113" : "#ffffff");
      setResolved(value);
    };
    apply();
    savePreference("jelly.theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return { theme, setTheme, resolved };
}
