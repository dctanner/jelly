/** Exact external origins accepted through a configured local reverse proxy. */
export function publicOrigins(value = ""): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((value) => {
          const url = new URL(value);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
          )
            throw new Error(
              "JELLY_PUBLIC_ORIGINS must contain comma-separated HTTP(S) origins without paths or credentials.",
            );
          return url.origin;
        }),
    ),
  ];
}
