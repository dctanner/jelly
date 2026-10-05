import { randomUUID } from "node:crypto";
import type { Page, ElementHandle, Request, FileChooser } from "playwright-core";
import { readBrowserUploadFiles } from "./browser-upload";

// Runs in Chromium for both observations and labels. Text ranges, rather than
// ancestor boxes, prevent long partially visible blocks leaking offscreen text.
function visibleBrowserText(root?: HTMLElement) {
  let text = "", visited = 0, characters = 0;
  const walker = document.createTreeWalker(
    root ?? document.body ?? document.documentElement, NodeFilter.SHOW_TEXT,
  );
  const range = document.createRange();
  while (visited++ < 10000 && characters < 24000 && text.length < 12000 && walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || parent.closest('input,textarea,select,script,style,noscript,[hidden],[aria-hidden="true"],[contenteditable]')) continue;
    const style = getComputedStyle(parent);
    if (style.visibility !== "visible" || style.display === "none" || style.opacity === "0") continue;
    const value = node.textContent ?? "";
    let included = false;
    for (let i = 0; i < value.length && characters < 24000 && text.length < 12000; i++) {
      characters++;
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) {
        text += value[i];
        included = true;
      }
    }
    if (included) text += " ";
  }
  return {
    text: text.slice(0, 12000),
    truncated: visited >= 10000 || characters >= 24000 || text.length >= 12000,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY },
  };
}

export type StructuredAction =
  "snapshot" | "fill" | "upload" | "tabs" | "scroll" | "wait_for" | "diagnostics";
/** Session-local capabilities; never locators that can silently resolve to replacement nodes. */
export class BrowserTools {
  private refs = new Map<string, ElementHandle<HTMLElement>>();
  private ids = new Map<Page, string>();
  private records: { pageId: string; kind: string; detail: string }[] = [];
  private removers = new Map<Page, () => void>();
  private epoch = 0;
  private cancelUploads = new Set<() => void>();
  constructor(private allowed: () => boolean) {}
  invalidate(clearDiagnostics = true) {
    this.epoch++;
    for (const cancel of [...this.cancelUploads]) cancel();
    for (const handle of this.refs.values())
      void handle.dispose().catch(() => {});
    this.refs.clear();
    if (clearDiagnostics) this.records = [];
  }
  dispose() {
    this.invalidate();
    for (const remove of this.removers.values()) remove();
    this.removers.clear();
    this.ids.clear();
  }
  track(page: Page) {
    if (this.ids.has(page)) return;
    // Bound host-side observers even if a site creates many popups. Older
    // unobserved tabs remain in Chromium but lose their capabilities.
    if (this.ids.size >= 20) {
      const oldest = this.ids.keys().next().value!;
      this.removers.get(oldest)?.();
      this.removers.delete(oldest);
      this.ids.delete(oldest);
      this.invalidate();
    }
    this.ids.set(page, randomUUID());
    const record = (kind: string, detail: string) => {
      if (!this.allowed()) return;
      this.records.push({ pageId: this.id(page), kind, detail });
      if (this.records.length > 50) this.records.shift();
    };
    // Do not read console arguments, message text, URLs, headers or payloads: all can contain credentials.
    const consoleError = (message: { type(): string }) => {
      if (message.type() === "error")
        record("console", "Console error (content redacted)");
    };
    const error = () =>
      record("pageerror", "Uncaught error (content redacted)");
    const failed = (request: Request) => {
      if (!this.allowed()) return;
      const kind = request.resourceType();
      const safeKind = [
        "document",
        "stylesheet",
        "image",
        "media",
        "font",
        "script",
        "texttrack",
        "xhr",
        "fetch",
        "eventsource",
        "websocket",
        "manifest",
      ].includes(kind)
        ? kind
        : "other";
      record(
        "requestfailed",
        `${safeKind} request failed (URL and error redacted)`,
      );
    };
    const navigated = () => this.invalidate();
    const close = () => {
      this.invalidate();
      this.removers.get(page)?.();
      this.removers.delete(page);
      this.ids.delete(page);
    };
    page.on("console", consoleError);
    page.on("pageerror", error);
    page.on("requestfailed", failed);
    page.on("framenavigated", navigated);
    page.on("close", close);
    this.removers.set(page, () => {
      page.off("console", consoleError);
      page.off("pageerror", error);
      page.off("requestfailed", failed);
      page.off("framenavigated", navigated);
      page.off("close", close);
    });
  }
  id(page: Page) {
    return this.ids.get(page)!;
  }
  page(id: unknown) {
    return [...this.ids].find(([, value]) => value === id)?.[0];
  }
  diagnostics() {
    return { entries: [...this.records], limit: 50, redacted: true };
  }
  async snapshot(page: Page, guard: () => void, includeElements = true) {
    this.invalidate(false);
    const epoch = this.epoch;
    const observationId = randomUUID();
    const data = await page.evaluate(visibleBrowserText, undefined);
    guard();
    if (epoch !== this.epoch)
      throw new Error("Page changed; take a new browser_snapshot.");
    if (!includeElements)
      return { pageId: this.id(page), observationId, ...data, elements: [] };
    const collection = await page.evaluateHandle(() => {
      const result: Element[] = [];
      const walker = document.createTreeWalker(
        document.documentElement,
        NodeFilter.SHOW_ELEMENT,
      );
      let scanned = 0;
      while (scanned++ < 10000 && result.length < 500 && walker.nextNode()) {
        const el = walker.currentNode as Element;
        if (
          el.matches(
            "a,button,input,textarea,select,[role=button],[role=menuitem],[contenteditable=true]",
          )
        )
          result.push(el);
      }
      return result;
    });
    try {
      guard();
    } catch (error) {
      await collection.dispose().catch(() => {});
      throw error;
    }
    const properties = await collection.getProperties();
    await collection.dispose();
    const handles = [...properties.values()]
      .map((h) => h.asElement())
      .filter(
        (h): h is ElementHandle<HTMLElement> => h !== null,
      ) as ElementHandle<HTMLElement>[];
    const elements: {
      ref: string;
      tag: string;
      type: string;
      label: string;
    }[] = [];
    try {
      for (const handle of handles.slice(0, 500)) {
        guard();
        const info = await handle.evaluate((el) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          if (
            !el.isConnected ||
            r.width <= 0 ||
            r.height <= 0 ||
            r.bottom <= 0 ||
            r.right <= 0 ||
            r.top >= innerHeight ||
            r.left >= innerWidth ||
            s.visibility !== "visible" ||
            s.display === "none" ||
            s.opacity === "0" ||
            el.closest('[hidden],[aria-hidden="true"]')
          )
            return null;
          const type = el.getAttribute("type") ?? "";
          // Labels only, never input values, placeholders, names, titles or hidden text.
          return {
            tag: el.tagName.toLowerCase(),
            type: type.slice(0, 40),
            label: "",
            hasLabel: el.matches("button,a,[role=button],[role=menuitem]"),
          };
        });
        if (info?.hasLabel)
          info.label = (await handle.evaluate(visibleBrowserText)).text.trim().slice(0, 160);
        guard();
        if (epoch !== this.epoch)
          throw new Error("Page changed; take a new browser_snapshot.");
        if (info && elements.length < 100) {
          const ref = randomUUID();
          this.refs.set(ref, handle as ElementHandle<HTMLElement>);
          elements.push({ ref, tag: info.tag, type: info.type, label: info.label });
        }
      }
      guard();
      if (epoch !== this.epoch)
        throw new Error("Page changed; take a new browser_snapshot.");
      return { pageId: this.id(page), observationId, ...data, elements };
    } finally {
      const retained = new Set(this.refs.values());
      await Promise.all(
        handles
          .filter((h) => !retained.has(h as ElementHandle<HTMLElement>))
          .map((h) => h.dispose().catch(() => {})),
      );
    }
  }
  async upload(page: Page, ref: unknown, paths: unknown, guard: () => void) {
    const handle = this.refs.get(String(ref));
    if (!handle)
      throw new Error("Stale or foreign reference; take a new browser_snapshot.");
    const epoch = this.epoch;
    const check = () => {
      guard();
      if (epoch !== this.epoch)
        throw new Error("Page changed; take a new browser_snapshot.");
    };
    check();
    const direct = await handle.evaluate(el =>
      el instanceof HTMLInputElement && el.type === "file");
    check();
    const files = await readBrowserUploadFiles(paths, check);
    check();
    {
      let input: ElementHandle = handle;
      if (!direct) {
        // Intercept only for this action, never while a person uses the browser.
        // Register before clicking so synchronous hidden-input choosers are caught.
        let resolve!: (chooser: FileChooser) => void;
        let reject!: (error: Error) => void;
        const pending = new Promise<FileChooser>((yes, no) => {
          resolve = yes; reject = no;
        });
        // A click failure can happen before we await the chooser.
        void pending.catch(() => {});
        const cancel = () => reject(new Error("Browser control or page changed during upload."));
        const received = (chooser: FileChooser) => resolve(chooser);
        const timer = setTimeout(() =>
          reject(new Error("No file chooser opened. Use a fresh reference to the upload button or file input.")), 5000);
        this.cancelUploads.add(cancel);
        page.on("filechooser", received);
        try {
          check();
          await this.target(ref, undefined, false, check);
          const chooser = await pending;
          check();
          if (chooser.page() !== page) throw new Error("Foreign file chooser.");
          input = chooser.element();
        } finally {
          clearTimeout(timer);
          page.off("filechooser", received);
          this.cancelUploads.delete(cancel);
        }
      }
      check();
      const valid = await input.evaluate((el, { count, direct }) => {
        // Sites may remove a transient input immediately after input.click().
        // The chooser owns that exact node, even while detached. Direct snapshot
        // references still require attachment; never retarget a replacement.
        if (!(el instanceof HTMLInputElement) || el.type !== "file" || (direct && !el.isConnected))
          return "Upload input changed; take a new browser_snapshot.";
        if (el.disabled) return "Upload input is disabled.";
        if (el.webkitdirectory) return "Directory uploads are not supported.";
        if (count > 1 && !el.multiple) return "This input only accepts one file.";
        return null;
      }, { count: files.length, direct });
      check();
      if (valid) throw new Error(valid);
      // Exact element, not a locator that could retry against a replacement.
      await input.setInputFiles(files, { timeout: 10000 });
      check();
      return {
        ok: true,
        files: files.map(({ name, buffer }) => ({ name, size: buffer.length })),
        note: "Files selected. Check the website for upload completion before saving or publishing.",
      };
    }
  }
  async target(ref: unknown, text: unknown, fill: boolean, guard: () => void) {
    const handle = this.refs.get(String(ref));
    if (!handle)
      throw new Error(
        "Stale or foreign reference; take a new browser_snapshot.",
      );
    guard();
    // One synchronous renderer task: no auto-wait/retry that could target a replacement after handoff.
    const result = await handle.evaluate(
      (el, args) => {
        if (!el.isConnected)
          return "Detached reference; take a new browser_snapshot.";
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        if (
          !r.width ||
          !r.height ||
          s.visibility !== "visible" ||
          s.display === "none" ||
          el.closest('[hidden],[aria-hidden="true"]')
        )
          return "Reference is not visible.";
        if (args.fill) {
          if (!(
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ))
            return "Reference is not a text field.";
          const identity = [
            el.type,
            el.name,
            el.id,
            el.autocomplete,
            el.getAttribute("aria-label"),
          ].join(" ");
          if (
            /password|secret|token|credential|one.?time|otp|\bpin\b|security.?code|auth.?code|access.?key|credit|card|cc-|cvc|cvv/i.test(
              identity,
            ) ||
            (el instanceof HTMLInputElement &&
              !["text", "email", "search", "url", "tel", "number"].includes(
                el.type,
              ))
          )
            return "Use request_browser_login for password or secret fields.";
          if (el.disabled || el.readOnly) return "Field is not editable.";
          const prototype =
            el instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
            el,
            args.text,
          );
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else el.click();
        return null;
      },
      { fill, text: String(text ?? "").slice(0, 24000) },
    );
    guard();
    if (result) throw new Error(result);
    return { ok: true };
  }
}
