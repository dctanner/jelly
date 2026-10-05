# Firecrawl web tools

`web_fetch` returns 300,000 Markdown characters by default (previously 30,000).
Use `maxCharacters` up to 1,000,000, or follow `nextStartIndex` for longer pages.
`includeLinks: true` includes the page's links for site discovery. There is no
per-site page counter or crawl-page cap. `web_search` accepts up to 100 results.

Provider requests allow 180 seconds, within a 185-second local deadline that
also covers pacing and retries. Cancellation interrupts both requests and waits.
HTTP 429 responses get up to three retries, respecting `Retry-After`; without
that header, backoff starts at 60 seconds. Provider bodies are never echoed in
errors.

The server paces requests across agents sharing a key. The default is 10
requests/minute, with a small rolling-window safety margin. Set
`FIRECRAWL_REQUESTS_PER_MINUTE` to the account's allowance for higher throughput;
an absent or invalid value uses 10. This setting cannot increase Firecrawl's
account rate limits or credit balance. Other servers using the same key also
consume that allowance, but cannot share this process-local scheduler.

## Live acceptance test

```sh
bun tests/web-tools.live.ts /tmp/phone-inc-firecrawl-report.json
```

This is an **opt-in, billable** test requiring `FIRECRAWL_API_KEY`; normal unit
tests never call the provider. It reads public sitemap XML for `www.phone.inc`
and `docs.phone.inc`, then fetches every listed webpage through the actual
`web_fetch` tool and follows additional links on those hosts. It excludes the
authenticated app, external hosts, and non-webpage assets.

The test has no arbitrary page cap and fails on missing/empty pages, truncation,
timeouts, credits/rate/concurrency limits (even if retries recover), or
incomplete discovery coverage. It prints counts and optionally writes per-page
evidence without credentials or page content. At the default account rate,
65 pages take roughly seven minutes. Run without other consumers of the key
for a clean rate-limit measurement.
