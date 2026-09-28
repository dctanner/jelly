import { constants } from "node:fs";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type {
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { GeneratedImage } from "../shared/generated-images";
import { isGeneratedImageUrl } from "../shared/generated-images";

const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_FRAME = 32 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function validatePng(bytes: Buffer) {
  if (
    bytes.length < 45 ||
    bytes.length > MAX_IMAGE ||
    !bytes.subarray(0, 8).equals(PNG) ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND" ||
    !bytes.readUInt32BE(16) ||
    !bytes.readUInt32BE(20) ||
    bytes.readUInt32BE(16) > 16384 ||
    bytes.readUInt32BE(20) > 16384
  )
    throw new Error("Image generation returned an invalid or oversized PNG.");
}

export class GeneratedImages {
  readonly directory: string;
  constructor(dataDir: string) {
    this.directory = join(dataDir, "generated-images");
  }
  async save(
    results: string[],
    alt: string,
    signal?: AbortSignal,
  ): Promise<GeneratedImage[]> {
    if (!results.length || results.length > 4)
      throw new Error("Expected between one and four generated images.");
    const bytes = results.map((result) => {
      if (result.length > MAX_FRAME)
        throw new Error("Generated image is too large.");
      const buffer = Buffer.from(result, "base64");
      if (buffer.toString("base64") !== result)
        throw new Error("Image generation returned invalid image data.");
      validatePng(buffer);
      return buffer;
    });
    signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const saved: GeneratedImage[] = [];
    try {
      for (const buffer of bytes) {
        signal?.throwIfAborted();
        const id = crypto.randomUUID();
        const image: GeneratedImage = {
          id,
          url: `/api/images/${id}.png`,
          mimeType: "image/png",
          alt: alt.slice(0, 1000),
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20),
        };
        saved.push(image);
        await writeFile(join(this.directory, `${id}.png`), buffer, {
          mode: 0o600,
          flag: "wx",
        });
      }
      signal?.throwIfAborted();
      return saved;
    } catch (error) {
      await this.remove(saved);
      throw error;
    }
  }
  async remove(images: GeneratedImage[]) {
    await Promise.all(
      images.map((image) =>
        unlink(join(this.directory, `${image.id}.png`)).catch(() => {}),
      ),
    );
  }
  async read(url: string): Promise<Buffer | null> {
    if (!isGeneratedImageUrl(url)) return null;
    let file;
    try {
      file = await open(
        join(this.directory, url.slice("/api/images/".length)),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE) return null;
      const bytes = await file.readFile();
      validatePng(bytes);
      return bytes;
    } catch {
      return null;
    } finally {
      await file?.close();
    }
  }
}

/** Native image_generation over the same Codex Responses endpoint and refreshed OAuth credentials. */
export async function generateSubscriptionImages(
  runtime: ModelRuntime,
  model: Model<Api>,
  prompt: string,
  signal?: AbortSignal,
  timeoutMs = 180000,
): Promise<string[]> {
  if (model.provider !== "openai-codex")
    throw new Error("Image generation requires ChatGPT subscription mode.");
  if (!prompt.trim() || prompt.length > 12000)
    throw new Error("Provide an image prompt of 1–12000 characters.");
  signal?.throwIfAborted();
  const auth = await runtime.getAuth(model, { signal });
  const token = auth?.auth.apiKey;
  if (!token)
    throw new Error("Connect ChatGPT in Settings to generate images.");
  let account: string;
  try {
    account = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    )["https://api.openai.com/auth"].chatgpt_account_id;
  } catch {
    throw new Error(
      "Reconnect ChatGPT: the subscription credential is invalid.",
    );
  }
  if (!account)
    throw new Error("Reconnect ChatGPT: the account identity is missing.");
  const base = (auth?.auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "");
  const url = new URL(
    base.endsWith("/codex/responses")
      ? base
      : `${base}${base.endsWith("/codex") ? "" : "/codex"}/responses`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // This server runs on Bun; lib.dom otherwise hides Bun's header overload.
    const Socket = WebSocket as unknown as new (
      url: URL,
      options: Bun.WebSocketOptions,
    ) => WebSocket;
    const ws = new Socket(url, {
      headers: {
        ...model.headers,
        ...auth?.auth.headers,
        Authorization: `Bearer ${token}`,
        "chatgpt-account-id": account,
        originator: "pi",
        "session-id": crypto.randomUUID(),
      },
    });
    let settled = false,
      received = 0;
    const images = new Map<string, string>();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      ws.close();
      error ? reject(error) : resolve([...images.values()]);
    };
    const abort = () => finish(new Error("Image generation cancelled."));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Image generation timed out. It may have used subscription quota; do not automatically retry.",
          ),
        ),
      timeoutMs,
    );
    const collect = (item: any) => {
      if (item?.type !== "image_generation_call" || item.result == null) return;
      if (
        typeof item.id !== "string" ||
        typeof item.result !== "string" ||
        item.result.length > MAX_FRAME
      )
        throw new Error("Invalid image generation result.");
      images.set(item.id, item.result);
      if (images.size > 4)
        throw new Error("Too many generated images in one response.");
    };
    ws.addEventListener("open", () => {
      if (settled) return;
      ws.send(
        JSON.stringify({
          type: "response.create",
          model: model.id,
          store: false,
          stream: true,
          instructions:
            "Generate the requested image using the image_generation tool. Do not substitute code or SVG illustrations.",
          input: [
            { role: "user", content: [{ type: "input_text", text: prompt }] },
          ],
          tools: [{ type: "image_generation", output_format: "png" }],
          tool_choice: { type: "image_generation" },
        }),
      );
    });
    ws.addEventListener("message", (event) => {
      if (settled) return;
      try {
        if (
          typeof event.data !== "string" ||
          event.data.length > MAX_FRAME ||
          (received += event.data.length) > 100 * 1024 * 1024
        )
          throw new Error("Image generation response is too large or invalid.");
        const e = JSON.parse(event.data);
        if (e.type === "error" || e.type === "response.failed") {
          const code = e.code ?? e.error?.code ?? e.response?.error?.code;
          throw new Error(
            code === "rate_limit_exceeded" || code === "usage_limit_reached"
              ? "ChatGPT image generation quota or rate limit reached. Try again later."
              : "ChatGPT rejected image generation. This account or model may not support the native image_generation tool. No API-key fallback was used.",
          );
        }
        if (e.type === "response.output_item.done") collect(e.item);
        if (["response.completed", "response.done"].includes(e.type)) {
          if (e.response?.status && e.response.status !== "completed")
            throw new Error("Image generation did not complete.");
          for (const item of e.response?.output ?? []) collect(item);
          if (!images.size)
            throw new Error(
              "ChatGPT returned no generated image. The request may have been declined or image generation may be unavailable.",
            );
          finish();
        }
        if (e.type === "response.incomplete")
          throw new Error(
            "Image generation was incomplete; no partial images were saved.",
          );
      } catch (error) {
        finish(
          error instanceof SyntaxError
            ? new Error("Invalid image generation response.")
            : (error as Error),
        );
      }
    });
    ws.addEventListener("error", () =>
      finish(
        new Error(
          "Could not connect to ChatGPT image generation. No API-key fallback was used.",
        ),
      ),
    );
    ws.addEventListener("close", () =>
      finish(
        new Error(
          "Image generation connection ended before completion. It may have used quota; do not automatically retry.",
        ),
      ),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function imageGenerationTool(
  runtime: ModelRuntime,
  model: Model<Api>,
  images: GeneratedImages,
  report: (type: string, data: Record<string, unknown>) => void,
): ToolDefinition {
  return {
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image with the connected ChatGPT subscription. Supply a detailed prompt. Images are saved privately and displayed in chat automatically. Returns local image URLs; do not substitute hand-drawn SVGs or repeat the image in Markdown. Do not automatically retry interrupted generations, which may have consumed quota.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 12000 }),
    }),
    execute: async (_id, args: any, signal) => {
      const results = await generateSubscriptionImages(
        runtime,
        model,
        args.prompt,
        signal,
      );
      const saved = await images.save(results, args.prompt, signal);
      try {
        report("image_generated", { images: saved });
      } catch (error) {
        await images.remove(saved);
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ images: saved, displayedInChat: true }),
          },
        ],
        details: { images: saved },
      };
    },
  };
}
