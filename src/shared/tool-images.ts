import type { Activity } from "./types";

export const IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;
export type ImageMimeType = keyof typeof IMAGE_TYPES;
export const MAX_TOOL_IMAGE_BYTES = 20 * 1024 * 1024;
export interface ToolImageContent {
  type: "image";
  mimeType: ImageMimeType;
  data: string;
}
export function isToolImageContent(value: unknown): value is ToolImageContent {
  if (!value || typeof value !== "object") return false;
  const image = value as Record<string, unknown>;
  return (
    image.type === "image" &&
    typeof image.mimeType === "string" &&
    Object.hasOwn(IMAGE_TYPES, image.mimeType) &&
    typeof image.data === "string" &&
    image.data.length > 0 &&
    image.data.length <= Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4
  );
}
export function toolContent(result: unknown): unknown[] {
  if (!result || typeof result !== "object") return [];
  const content = (result as Record<string, unknown>).content;
  return Array.isArray(content) ? content : [];
}
export function isToolImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^\/api\/tool-images\/([1-9]\d*)\/(0|[1-9]\d*)$/);
  return (
    !!match &&
    Number.isSafeInteger(Number(match[1])) &&
    Number.isSafeInteger(Number(match[2]))
  );
}
export function toolImages(event: Activity) {
  if (
    event.type !== "tool_completed" ||
    event.data.isError ||
    !Number.isSafeInteger(event.id) ||
    event.id < 1
  )
    return [];
  return toolContent(event.data.result).flatMap((content, index) =>
    isToolImageContent(content)
      ? [
          {
            url: `/api/tool-images/${event.id}/${index}`,
            mimeType: content.mimeType,
            alt: `Image from ${typeof event.data.name === "string" ? event.data.name : "tool"}`,
          },
        ]
      : [],
  );
}

/** Keep tool diagnostics useful without putting megabytes of base64 in the DOM. */
export function toolResultForDisplay(result: unknown): unknown {
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray((result as Record<string, unknown>).content)
  )
    return result;
  return {
    ...result,
    content: toolContent(result).map((content) =>
      content &&
      typeof content === "object" &&
      (content as Record<string, unknown>).type === "image"
        ? { ...content, data: "[image attachment]" }
        : content,
    ),
  };
}
