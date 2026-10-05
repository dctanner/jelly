import { expect, mock, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { webTools } from "../src/server/web-tools";

function fixture(
  respond: (request: Request) => Response | Promise<Response>,
  options: {
    apiKey?: () => string | undefined;
    timeoutMs?: number;
    requestsPerMinute?: number;
  } = {},
) {
  const fetcher = mock((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(respond(new Request(input, init))),
  );
  const tools = webTools({
    apiKey: () => "fc-test-private-key",
    fetch: fetcher as unknown as typeof fetch,
    requestsPerMinute: 0,
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
      timeout: 180000,
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
  const markdown = "x".repeat(300000) + "last section";
  const f = fixture(async (req) => {
    expect(req.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(await req.json()).toEqual({
      url: "https://example.com",
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 180000,
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
  expect(first.markdown).toHaveLength(300000);
  expect(first.title).toBe("Page");
  expect(first.sourceURL).toBe("https://example.com/page");
  expect(first.statusCode).toBe(200);
  expect(first.nextStartIndex).toBe(300000);
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

test("search accepts 100 results rather than capping discovery at ten", async () => {
  const web = Array.from({ length: 100 }, (_, i) => ({
    url: `https://example.com/${i}`,
  }));
  const f = fixture(async (req) => {
    expect((await req.json()).limit).toBe(100);
    return Response.json({ success: true, data: { web } });
  });
  expect(
    data(await f.call("web_search", { query: "site:example.com", limit: 100 }))
      .results,
  ).toEqual(web);
});

test("fetch can return a million characters and discover all page links", async () => {
  const markdown = "x".repeat(1_000_000) + "tail";
  const links = Array.from(
    { length: 150 },
    (_, i) => `https://example.com/${i}`,
  );
  const f = fixture(async (req) => {
    expect((await req.json()).formats).toEqual(["markdown", "links"]);
    return Response.json({
      success: true,
      data: { markdown, links: [...links, null, 3] },
    });
  });
  const page = data(
    await f.call("web_fetch", {
      url: "https://example.com",
      maxCharacters: 1_000_000,
      includeLinks: true,
    }),
  );
  expect(page.markdown).toHaveLength(1_000_000);
  expect(page.nextStartIndex).toBe(1_000_000);
  expect(page.links).toEqual(links);
  const last = data(
    await f.call("web_fetch", {
      url: "https://example.com",
      startIndex: page.nextStartIndex,
      includeLinks: true,
    }),
  );
  expect(last.markdown).toBe("tail");
  expect(last.nextStartIndex).toBeNull();
});

test("fetch retains caller-selected small pages and exact-boundary pagination", async () => {
  const f = fixture(() =>
    Response.json({ success: true, data: { markdown: "abcdef" } }),
  );
  const first = data(
    await f.call("web_fetch", { url: "https://example.com", maxCharacters: 3 }),
  );
  expect(first.markdown).toBe("abc");
  expect(first.nextStartIndex).toBe(3);
  const last = data(
    await f.call("web_fetch", {
      url: "https://example.com",
      startIndex: 3,
      maxCharacters: 3,
    }),
  );
  expect(last.markdown).toBe("def");
  expect(last.nextStartIndex).toBeNull();
  expect(last.links).toBeUndefined();
});

test("rate limits retry up to three times without leaking provider errors", async () => {
  let attempts = 0;
  const f = fixture(() =>
    ++attempts < 4
      ? new Response("private", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      : Response.json({ success: true, data: { markdown: "complete" } }),
  );
  expect(
    data(await f.call("web_fetch", { url: "https://example.com" })).markdown,
  ).toBe("complete");
  expect(f.fetcher).toHaveBeenCalledTimes(4);
  const exhausted = fixture(
    () =>
      new Response("private", { status: 429, headers: { "retry-after": "0" } }),
  );
  await expect(
    exhausted.call("web_fetch", { url: "https://example.com" }),
  ).rejects.toThrow("rate limit");
  expect(exhausted.fetcher).toHaveBeenCalledTimes(4);
});

test("rate-limit backoff respects Retry-After and remains cancellable and deadline-bound", async () => {
  for (const header of [
    "60",
    new Date(Date.now() + 60000).toUTCString(),
    "invalid",
  ]) {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      const f = fixture(
        () => {
          if (cancel) setTimeout(() => controller.abort(), 5);
          return new Response("private", {
            status: 429,
            headers: { "retry-after": header },
          });
        },
        { timeoutMs: cancel ? 5000 : 20 },
      );
      await expect(
        f.call("web_fetch", { url: "https://example.com" }, controller.signal),
      ).rejects.toThrow(cancel ? "cancelled" : "timed out");
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    }
  }
});

test("tool schemas advertise the increased limits", () => {
  const tools = webTools();
  expect(
    tools.find((tool) => tool.name === "web_search")!.parameters,
  ).toMatchObject({
    properties: { limit: { maximum: 100 } },
  });
  expect(
    tools.find((tool) => tool.name === "web_fetch")!.parameters,
  ).toMatchObject({
    properties: { maxCharacters: { default: 300_000, maximum: 1_000_000 } },
  });
});

test("pacing is shared across toolsets, not reset for each agent", async () => {
  const starts: number[] = [];
  const respond = () => {
    starts.push(Date.now());
    return Response.json({ success: true, data: { markdown: "ok" } });
  };
  const options = {
    apiKey: () => "fc-shared-pacing-test",
    requestsPerMinute: 6000,
  };
  const first = fixture(respond, options);
  const second = fixture(respond, options);
  await Promise.all([
    first.call("web_fetch", { url: "https://example.com/1" }),
    second.call("web_fetch", { url: "https://example.com/2" }),
    first.call("web_fetch", { url: "https://example.com/3" }),
  ]);
  expect(starts).toHaveLength(3);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(100);
  expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(100);
});

test("queued requests can be cancelled or time out without reaching Firecrawl", async () => {
  for (const cancel of [true, false]) {
    const f = fixture(
      () => Response.json({ success: true, data: { markdown: "ok" } }),
      {
        apiKey: () => `fc-queued-${cancel}`,
        requestsPerMinute: 10,
        timeoutMs: cancel ? 5000 : 20,
      },
    );
    await f.call("web_fetch", { url: "https://example.com/first" });
    const controller = new AbortController();
    const pending = f.call(
      "web_fetch",
      { url: "https://example.com/queued" },
      controller.signal,
    );
    if (cancel) controller.abort();
    await expect(pending).rejects.toThrow(cancel ? "cancelled" : "timed out");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  }
});

test("a 65-page crawl has no cumulative page or content cap", async () => {
  const markdown = "x".repeat(50_000);
  const f = fixture(() => Response.json({ success: true, data: { markdown } }));
  for (let i = 0; i < 65; i++) {
    const page = data(
      await f.call("web_fetch", { url: `https://example.com/${i}` }),
    );
    expect(page.markdown).toBe(markdown);
    expect(page.nextStartIndex).toBeNull();
  }
  expect(f.fetcher).toHaveBeenCalledTimes(65);
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
        new Response("fc-test-private-key private provider error", {
          status,
          headers: { "retry-after": "0" },
        }),
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
