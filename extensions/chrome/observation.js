/** Packaged isolated-world program. Never accepts source code or selectors from RPC. */
export function observation(operation, args, expectedOrigin, epoch) {
  // Return fixed guard categories across executeScript, never exception text.
  let failure;
  const fail = (reason = "unsupported_operation") => {
    failure = reason;
    throw new Error("Observation blocked");
  };
  try {
    if (location.origin !== expectedOrigin) fail("origin_changed");
    if (document.querySelector("object,embed")) fail("unsupported_embed");
    const all = document.querySelectorAll("*");
    // The extension-only DOM API sees closed author roots too. Light-DOM
    // inspection cannot establish screenshot eligibility for their pixels; reject
    // the whole document rather than exposing or traversing private root contents.
    // If Chrome cannot provide this inspection, observations fail closed.
    if (all.length > 10000) fail("dom_limit");
    if (typeof chrome?.dom?.openOrClosedShadowRoot !== "function")
      fail("shadow_inspection_unavailable");
    if (
      // Chrome's API accepts HTMLElement, not SVGElement/MathMLElement.
      // HTML hosts nested inside SVG foreignObject are still scanned.
      [...all].some(
        (el) =>
          el instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(el),
      )
    )
      fail("shadow_root");
    const secret = (el) =>
      /password|secret|token|credential|one.?time|otp|\bpin\b|security.?code|auth.?code|access.?key|credit|card|cc-|cvc|cvv/i.test(
        [
          el.type,
          el.name,
          el.id,
          el.autocomplete,
          el.getAttribute("aria-label"),
        ].join(" "),
      );
    const fields = [
      ...document.querySelectorAll("input,textarea,[contenteditable]"),
    ];
    if (fields.some((el) => secret(el))) fail("secret_field");
    const visibleBounds = (el, clipSelf = false) => {
      if (!el.isConnected || el.closest('[hidden],[aria-hidden="true"]'))
        return null;
      const bounds = {
        left: 0,
        top: 0,
        right: innerWidth,
        bottom: innerHeight,
      };
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
        const s = getComputedStyle(ancestor);
        if (
          s.visibility !== "visible" ||
          s.display === "none" ||
          Number(s.opacity) === 0
        )
          return null;
        if (ancestor === el && !clipSelf) continue;
        const clipX = /^(hidden|clip|scroll|auto)$/.test(s.overflowX);
        const clipY = /^(hidden|clip|scroll|auto)$/.test(s.overflowY);
        if (!clipX && !clipY) continue;
        const r = ancestor.getBoundingClientRect();
        const scaleX = ancestor.offsetWidth
          ? r.width / ancestor.offsetWidth
          : 1;
        const scaleY = ancestor.offsetHeight
          ? r.height / ancestor.offsetHeight
          : 1;
        const left = r.left + ancestor.clientLeft * scaleX;
        const top = r.top + ancestor.clientTop * scaleY;
        if (clipX) {
          bounds.left = Math.max(bounds.left, left);
          bounds.right = Math.min(
            bounds.right,
            left + ancestor.clientWidth * scaleX,
          );
        }
        if (clipY) {
          bounds.top = Math.max(bounds.top, top);
          bounds.bottom = Math.min(
            bounds.bottom,
            top + ancestor.clientHeight * scaleY,
          );
        }
      }
      return bounds;
    };
    const intersects = (r, bounds) =>
      bounds &&
      Math.min(r.right, bounds.right) > Math.max(r.left, bounds.left) &&
      Math.min(r.bottom, bounds.bottom) > Math.max(r.top, bounds.top);
    const visible = (el) =>
      intersects(el.getBoundingClientRect(), visibleBounds(el));
    const textWithin = (root, limit) => {
      let text = "",
        visited = 0,
        characters = 0;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
        range = document.createRange();
      while (
        visited++ < 10000 &&
        characters < 24000 &&
        text.length < limit &&
        walker.nextNode()
      ) {
        const node = walker.currentNode,
          parent = node.parentElement;
        if (
          !parent ||
          parent.closest(
            'input,textarea,select,script,style,noscript,[hidden],[aria-hidden="true"],[contenteditable]',
          ) ||
          !visible(parent)
        )
          continue;
        const value = node.textContent ?? "";
        const bounds = visibleBounds(parent, true);
        let included = false;
        for (
          let i = 0;
          i < value.length && characters < 24000 && text.length < limit;
          i++
        ) {
          characters++;
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          if (intersects(r, bounds)) {
            text += value[i];
            included = true;
          }
        }
        if (included) text += " ";
      }
      return {
        text: text.slice(0, limit),
        truncated:
          visited >= 10000 || characters >= 24000 || text.length >= limit,
      };
    };
    // A worker-only top-document fallback can omit ALL child documents from
    // text observations/actions. It never permits a screenshot of these pixels.
    // Never infer a child document's visibility from its own viewport.
    let framesOmitted = false;
    for (const frame of document.querySelectorAll("iframe,frame")) {
      const rect = frame.getBoundingClientRect(),
        bounds = visibleBounds(frame);
      // This includes inherited helper frames: none of their content is read,
      // and accessibility-hidden is not proof that their pixels are hidden.
      const src = frame.getAttribute("src");
      if (
        !bounds ||
        !visible(frame) ||
        frame.hasAttribute("srcdoc") ||
        !src ||
        /^about:(?:blank|srcdoc)(?:[?#]|$)/i.test(src.trim()) ||
        rect.left < bounds.left ||
        rect.top < bounds.top ||
        rect.right > bounds.right ||
        rect.bottom > bounds.bottom
      ) {
        if (args.topDocumentOnly === true && operation !== "screenshot")
          framesOmitted = true;
        else fail("unsupported_frame");
      }
    }
    const stateKey = "__jellyExactReferences";
    if (operation === "guard") return { ok: true, framesOmitted };
    if (operation === "screenshot") {
      if (fields.some((el) => el.value || el.isContentEditable))
        fail("screenshot_form_content");
      return { ok: true };
    }
    if (operation === "snapshot") {
      const refs = new Map();
      globalThis[stateKey] = { epoch, refs };
      const text = textWithin(document.body ?? document.documentElement, 12000);
      const elements = [];
      for (const el of document.querySelectorAll(
        "a,button,input,textarea,select,[role=button]",
      )) {
        if (elements.length >= 100) break;
        if (!visible(el)) continue;
        const ref = crypto.randomUUID();
        refs.set(ref, el);
        elements.push({
          ref,
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") ?? "").slice(0, 40),
          label: el.matches("button,a,[role=button]")
            ? textWithin(el, 160).text
            : "",
        });
      }
      return {
        ...text,
        ready: document.readyState !== "loading",
        elements,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          deviceScaleFactor: devicePixelRatio,
          scrollX,
          scrollY,
        },
      };
    }
    const state = globalThis[stateKey];
    if (operation === "scroll") {
      window.scrollBy(args.x ?? 0, args.y);
      return { ok: true };
    }
    if (!state || state.epoch !== epoch || !state.refs.has(args.ref))
      fail("stale_reference");
    const el = state.refs.get(args.ref);
    if (!visible(el) || secret(el)) fail();
    if (operation === "fill") {
      if (
        !(
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ) ||
        el.disabled ||
        el.readOnly ||
        (el instanceof HTMLInputElement &&
          !["text", "email", "search", "url", "tel", "number"].includes(
            el.type,
          ))
      )
        fail();
      const proto =
        el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, args.text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (operation === "select") {
      if (
        !(el instanceof HTMLSelectElement) ||
        el.disabled ||
        ![...el.options].some((o) => o.value === args.value && !o.disabled)
      )
        fail();
      el.value = args.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (operation === "key") {
      // Exact-element semantic activation only: no browser/global shortcuts or
      // arbitrary typing into the focused element.
      if (
        ![
          "Enter",
          "Space",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Escape",
        ].includes(args.key) ||
        !el.matches("button,select,[role=button]") ||
        el.disabled
      )
        fail();
      if (
        (args.key === "Enter" || args.key === "Space") &&
        el.matches("button,[role=button]")
      )
        el.click();
      else {
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: args.key === "Space" ? " " : args.key,
            bubbles: true,
          }),
        );
        el.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: args.key === "Space" ? " " : args.key,
            bubbles: true,
          }),
        );
      }
    } else if (operation === "click") {
      if (el.matches("input[type=file],input[type=password],a[download]"))
        fail();
      const anchor = el.closest("a");
      if (
        anchor &&
        new URL(anchor.href, location.href).origin !== expectedOrigin
      )
        fail();
      el.click();
    } else fail();
    state.refs.clear();
    return { ok: true };
  } catch {
    return { observationBlocked: failure ?? "unsupported_operation" };
  }
}
