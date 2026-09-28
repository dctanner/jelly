export interface GeneratedImage {
  id: string;
  url: string;
  mimeType: "image/png";
  alt: string;
  width?: number;
  height?: number;
}

/** Only private Jelly image endpoints may be embedded; no remote trackers/SVG. */
export function isGeneratedImageUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\/api\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/.test(
      value,
    )
  );
}
