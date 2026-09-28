import { expect, mock, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { webTools } from "../src/server/web-tools";

function fixture(
  respond: (request: Request) => Response | Promise<Response>,
  options: { apiKey?: () => string | undefined; timeoutMs?: number } = {},
) {
  const fetcher = mock((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(respond(new Request(input, init))),
  );
  const tools = webTools({
    apiKey: () => "fc-test-private-key",
    fetch: fetcher as unknown as typeof fetch,
    ...options,
  });
  return {
    fetcher,
    call: (name: string, args: unknown, signal?: AbortSignal) =>
      tools
        .find((tool) => tool.name === name)!
        .execute("test", args, signal, undefined, {} as ExtensionContext),
  };
}
function data(result: Awaited<ReturnType<ReturnType<typeof fixture>["call"]>>) {
  const content = result.content[0]!;
  if (content.type !== "text") throw new Error("Expected text result");
  return JSON.parse(content.text);
}

test("search uses Firecrawl v2 and returns source links and snippets", async () => {
  const f = fixture(async (req) => {
    expect(req.url).toBe("https://api.firecrawl.dev/v2/search");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer fc-test-private-key");
    expect(await req.json()).toEqual({
      query: "site:example.com research",
      limit: 5,
      sources: ["web"],
      timeout: 60000,
    });
    return Response.json({
      success: true,
      data: {
        web: [
          {
            title: "Research",
            url: "https://example.com",
            description: "A source",
          },
        ],
      },
    });
  });
  expect(
    data(await f.call("web_search", { query: "site:example.com research" })),
  ).toEqual({
    query: "site:example.com research",
    results: [
      {
        title: "Research",
        url: "https://example.com",
        description: "A source",
      },
    ],
  });
});

test("search respects requested limits and empty results", async () => {
  const f = fixture(async (req) => {
    expect((await req.json()).limit).toBe(2);
    return Response.json({ success: true, data: { web: [] } });
  });
  expect(
    data(await f.call("web_search", { query: "no matches", limit: 2 })).results,
  ).toEqual([]);
});

test("fetch requests main-content Markdown and pages long results without losing the source", async () => {
  const markdown = "x".repeat(30000) + "last section";
  const f = fixture(async (req) => {
    expect(req.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(await req.json()).toEqual({
      url: "https://example.com",
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 60000,
    });
    return Response.json({
      success: true,
      data: {
        markdown,
        metadata: {
          title: "Page",
          sourceURL: "https://example.com/page",
          statusCode: 200,
        },
      },
    });
  });
  const first = data(await f.call("web_fetch", { url: "https://example.com" }));
  expect(first.markdown).toHaveLength(30000);
  expect(first.title).toBe("Page");
  expect(first.sourceURL).toBe("https://example.com/page");
  expect(first.statusCode).toBe(200);
  expect(first.nextStartIndex).toBe(30000);
  expect(first.totalCharacters).toBe(markdown.length);
  const second = data(
    await f.call("web_fetch", {
      url: "https://example.com",
      startIndex: first.nextStartIndex,
    }),
  );
  expect(second.markdown).toBe("last section");
  expect(second.nextStartIndex).toBeNull();
});

test("missing keys and invalid input fail before any network request", async () => {
  const f = fixture(() => Response.json({}), { apiKey: () => " " });
  await expect(f.call("web_search", { query: "test" })).rejects.toThrow(
    "FIRECRAWL_API_KEY",
  );
  await expect(f.call("web_search", { query: "  " })).rejects.toThrow("empty");
  for (const url of [
    "bad-url",
    "file:///etc/passwd",
    "https://user:secret@example.com",
  ])
    await expect(f.call("web_fetch", { url })).rejects.toThrow("URL");
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("HTTP errors are actionable and never echo provider error bodies", async () => {
  for (const [status, message] of [
    [401, "FIRECRAWL_API_KEY"],
    [403, "account access"],
    [402, "credits"],
    [429, "rate limit"],
    [500, "Try again"],
  ] as const) {
    const f = fixture(
      () =>
        new Response("fc-test-private-key private provider error", { status }),
    );
    const error = await f
      .call("web_search", { query: "test" })
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain("private");
  }
});

test("unsuccessful, malformed and unreadable responses produce tool failures", async () => {
  for (const response of [
    () => new Response("not JSON"),
    () => Response.json({ success: false, error: "private provider error" }),
    () => Response.json({ success: true, data: {} }),
  ]) {
    const f = fixture(response);
    await expect(f.call("web_search", { query: "test" })).rejects.toThrow(
      "Firecrawl",
    );
    await expect(
      f.call("web_fetch", { url: "https://example.com" }),
    ).rejects.toThrow("Firecrawl");
  }
});

test("stopping a run cancels in-flight web requests and requests time out", async () => {
  for (const cancel of [true, false]) {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = fixture(
      (req) =>
        new Promise((_resolve, reject) => {
          req.signal.addEventListener(
            "abort",
            () => reject(req.signal.reason),
            { once: true },
          );
          started();
        }),
      { timeoutMs: cancel ? 5000 : 10 },
    );
    const controller = new AbortController();
    const pending = f
      .call("web_fetch", { url: "https://example.com" }, controller.signal)
      .catch((error: Error) => error);
    await ready;
    if (cancel) controller.abort();
    expect(String(await pending)).toContain(cancel ? "cancelled" : "timed out");
  }
});
