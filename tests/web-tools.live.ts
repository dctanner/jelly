// Opt-in, billable acceptance test: bun tests/web-tools.live.ts [report.json]
// Public marketing + documentation sites only; never enters app.phone.inc.
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { webTools } from "../src/server/web-tools";

assert(
  process.env.FIRECRAWL_API_KEY?.trim(),
  "Set FIRECRAWL_API_KEY on the server before running this live test.",
);
const startedAt = new Date().toISOString();
const hosts = new Set(["www.phone.inc", "docs.phone.inc"]);
const pending = new Set<string>();
const sitemaps = new Set<string>();
const pages: { url: string; characters: number; milliseconds: number }[] = [];
const failures: { url: string; error: string }[] = [];
const limits: {
  endpoint: string;
  status: number;
  concurrencyLimited?: boolean;
}[] = [];
let requests = 0;

function pageURL(value: string, base?: string) {
  const url = new URL(value, base);
  if (url.hostname === "phone.inc") url.hostname = "www.phone.inc";
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.host) ||
    url.username ||
    url.password
  )
    return null;
  url.hash = "";
  url.search = "";
  // Crawl webpages, not downloads, images, scripts, or machine-readable feeds.
  if (/\.[a-z\d]+$/i.test(url.pathname) && !/\.html?$/i.test(url.pathname))
    return null;
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.href;
}

async function sitemap(url: string) {
  assert(hosts.has(new URL(url).host), `Unexpected sitemap host: ${url}`);
  if (sitemaps.has(url)) return;
  sitemaps.add(url);
  // Firecrawl's Markdown renderer concatenates XML <loc> elements. Read only
  // discovery XML directly; every actual page goes through Jelly's web_fetch.
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert(response.ok, `Sitemap HTTP ${response.status}: ${url}`);
  const xml = await response.text();
  const locations = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) =>
    m[1]!.replaceAll("&amp;", "&"),
  );
  assert(locations.length, `Empty or invalid sitemap: ${url}`);
  for (const location of locations) {
    if (/<sitemapindex[\s>]/.test(xml)) await sitemap(location);
    else {
      const page = pageURL(location);
      assert(page, `Unexpected sitemap page: ${location}`);
      pending.add(page);
    }
  }
}

const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  requests++;
  const response = await fetch(input, init);
  const endpoint = new URL(input instanceof Request ? input.url : input)
    .pathname;
  if ([402, 408, 429, 504].includes(response.status))
    limits.push({ endpoint, status: response.status });
  if (response.ok) {
    const body = await response.clone().json();
    if (body.data?.metadata?.concurrencyLimited)
      limits.push({
        endpoint,
        status: response.status,
        concurrencyLimited: true,
      });
  }
  return response;
}) as typeof fetch;
const tool = webTools({ fetch: fetcher }).find((t) => t.name === "web_fetch")!;
let sitemapPages = 0;
try {
  await sitemap("https://www.phone.inc/sitemap-index.xml");
  await sitemap("https://docs.phone.inc/sitemap.xml");
  sitemapPages = pending.size;
  assert(
    sitemapPages >= 48,
    "Discovery returned fewer than the known 48 marketing pages.",
  );
  console.log(
    `Discovered ${sitemapPages} sitemap pages; following additional same-site links without a page cap.`,
  );
  // Sequential requests deliberately avoid an artificial concurrency burst.
  // A Set iterator also visits newly discovered URLs; no arbitrary slice/cap.
  for (const url of pending) {
    const start = Date.now();
    try {
      const result = await tool.execute(
        "phone-inc-live",
        { url, includeLinks: true },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      const content = result.content[0];
      assert(content?.type === "text", "Expected text result");
      const page = JSON.parse(content.text);
      assert.equal(page.statusCode, 200, "Page HTTP status");
      assert(page.markdown.trim().length > 0, "Empty Markdown");
      assert.equal(
        page.nextStartIndex,
        null,
        "Default fetch character limit reached",
      );
      assert.equal(
        page.markdown.length,
        page.totalCharacters,
        "Incomplete page",
      );
      for (const link of page.links) {
        const discovered = pageURL(link, url);
        if (discovered) pending.add(discovered);
      }
      pages.push({
        url,
        characters: page.totalCharacters,
        milliseconds: Date.now() - start,
      });
      console.log(
        `PASS ${pages.length}/${pending.size} ${url} (${page.totalCharacters} characters)`,
      );
    } catch (error) {
      failures.push({
        url,
        error: error instanceof Error ? error.message : "Unknown failure",
      });
      console.error(`FAIL ${url}: ${failures.at(-1)!.error}`);
    }
    // Do not keep spending credits or retrying the site after a provider quota hit.
    if (limits.length) break;
  }
} catch (error) {
  failures.push({
    url: "discovery",
    error: error instanceof Error ? error.message : "Unknown failure",
  });
}
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  scope: [...hosts],
  sitemaps: [...sitemaps],
  sitemapPages,
  discoveredPages: pending.size,
  completedPages: pages.length,
  requests,
  totalCharacters: pages.reduce((sum, page) => sum + page.characters, 0),
  largestPageCharacters: Math.max(0, ...pages.map((page) => page.characters)),
  limits,
  failures,
  pages,
  passed:
    failures.length === 0 &&
    limits.length === 0 &&
    pages.length === pending.size &&
    pages.length > 0,
};
if (process.argv[2])
  await Bun.write(process.argv[2], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, pages: undefined }, null, 2));
if (!report.passed) process.exitCode = 1;
