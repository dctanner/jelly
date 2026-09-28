import {
  IMAGE_TYPES,
  MAX_TOOL_IMAGE_BYTES,
  isToolImageContent,
  isToolImageUrl,
  toolContent,
} from "../shared/tool-images";
import type { Store } from "./store";
import { rasterMime } from "./raster-images";

/** Read the durable timeline, not the bounded SSE replay log. Never open agent-supplied paths. */
export function readToolImage(store: Store, url: string) {
  if (!isToolImageUrl(url)) return null;
  const [, , , eventId, index] = url.split("/");
  const event = store.timelineEvent(Number(eventId));
  if (!event || event.type !== "tool_completed" || event.data.isError)
    return null;
  const image = toolContent(event.data.result)[Number(index)];
  if (!isToolImageContent(image)) return null;
  const bytes = Buffer.from(image.data, "base64");
  if (
    bytes.length > MAX_TOOL_IMAGE_BYTES ||
    bytes.toString("base64") !== image.data
  )
    return null;
  if (rasterMime(bytes) !== image.mimeType) return null;
  return {
    bytes,
    mimeType: image.mimeType,
    extension: IMAGE_TYPES[image.mimeType],
  };
}
