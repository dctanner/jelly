export interface RenderedFile {
  id: string;
  url: string;
  name: string;
  kind: "image" | "text";
  mimeType: string;
  size: number;
}
export function isRenderedFileUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\/api\/rendered-files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}
export function isRenderedFile(value: unknown): value is RenderedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    isRenderedFileUrl(file.url) &&
    typeof file.name === "string" &&
    (file.kind === "image" || file.kind === "text") &&
    typeof file.mimeType === "string" &&
    typeof file.size === "number" &&
    Number.isSafeInteger(file.size) &&
    file.size >= 0
  );
}
