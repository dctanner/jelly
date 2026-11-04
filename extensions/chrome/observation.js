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
    // Detect, but never traverse, open or closed author roots. Text observations
    // omit the host and all light-DOM descendants (including slotted content).
    // Their pixels remain uncertifiable, so screenshots still fail closed.
    if (all.length > 10000) fail("dom_limit");
    if (typeof chrome?.dom?.openOrClosedShadowRoot !== "function")
      fail("shadow_inspection_unavailable");
    const hosts = [...all].filter(
      // Chrome's API accepts HTMLElement, not SVGElement/MathMLElement.
      (el) => el instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(el),
    );
    if (hosts.length && operation === "screenshot") fail("shadow_root");
    const shadowRootsOmitted = hosts.length > 0;
    const scopeKey = "__jellyShadowScope";
    let scope = globalThis[scopeKey];
    if (!scope || scope.hosts.length !== hosts.length ||
        hosts.some((host, i) => scope.hosts[i] !== host)) {
      scope = globalThis[scopeKey] = { hosts, id: crypto.randomUUID() };
    }
    // contains() does not cross a shadow boundary. A previously admitted ref
    // can move into an existing closed root without changing the host set.
    // Root identity rejects that ref without inspecting private root contents.
    const omitted = (el) => el.getRootNode() !== document ||
      hosts.some((host) => host === el || host.contains(el));
    // An ancestor control could activate omitted content indirectly.
    const omittedControl = (el) => omitted(el) || hosts.some((host) => el.contains(host));
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
      if (omitted(el) || !el.isConnected || el.closest('[hidden],[aria-hidden="true"]'))
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
        // Restrict exposure even before the browser's privileged-frame commit
        // event arrives. This never grants access based on a page-owned src.
        /^chrome-extension:/i.test(src.trim()) ||
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
    if (operation === "guard") return {
      ok: true, framesOmitted, shadowRootsOmitted, shadowScope: scope.id,
    };
    if (operation === "screenshot") {
      if (fields.some((el) => el.value || el.isContentEditable))
        fail("screenshot_form_content");
      return { ok: true };
    }
    if (operation === "snapshot") {
      const refs = new Map();
      globalThis[stateKey] = { epoch, refs, shadowScope: scope.id };
      const text = textWithin(document.body ?? document.documentElement, 12000);
      const elements = [];
      for (const el of document.querySelectorAll(
        "a,button,input,textarea,select,[role=button]",
      )) {
        if (elements.length >= 100) break;
        if (!visible(el) || omittedControl(el)) continue;
        const ref = crypto.randomUUID();
        refs.set(ref, el);
        elements.push({
          ref,
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") ?? "").slice(0, 40),
          // Keep the ref on the actionable element, not its text child. Icon
          // buttons (including Gmail's) often expose only an accessible label.
          label:
            (el.getAttribute("aria-label") ?? "").trim().slice(0, 160) ||
            (el.matches("button,a,[role=button]")
              ? textWithin(el, 160).text
              : ""),
        });
      }
      return {
        ...text,
        shadowRootsOmitted,
        shadowScope: scope.id,
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
    if (!state || state.epoch !== epoch || state.shadowScope !== scope.id || !state.refs.has(args.ref))
      fail("stale_reference");
    const el = state.refs.get(args.ref);
    const check = () => {
      // Every exact operation rechecks its target after synchronous handlers.
      // Event handlers can create a root or move the exact target into one.
      // Recheck the omission boundary before every subsequent dispatch.
      const currentElements = document.querySelectorAll("*");
      if (currentElements.length > 10000) fail("dom_limit");
      if ([...currentElements].some((node) =>
        node.matches("input,textarea,[contenteditable]") && secret(node)))
        fail("secret_field");
      const currentHosts = [...currentElements].filter((node) =>
        node instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(node));
      if (currentHosts.length !== hosts.length ||
          currentHosts.some((host, i) => host !== hosts[i])) fail("stale_reference");
      if (
        location.origin !== expectedOrigin ||
        !visible(el) ||
        omittedControl(el) ||
        secret(el) ||
        el.matches(
          ":disabled,input[type=file],input[type=password],a[download]",
        ) ||
        el.closest('[inert],[aria-disabled="true"]')
      )
        fail();
      const anchor = el.closest("a");
      if (
        anchor &&
        new URL(anchor.href, location.href).origin !== expectedOrigin
      )
        fail();
    };
    const activate = () => {
      check();
      // Consume before the first event: a handler can remove the target or
      // navigate, and a partially dispatched activation must never be replayed.
      state.refs.clear();
      if (el.matches('[role="button"]') && !el.matches("button,input,select")) {
        // Custom controls such as Closure toolbars arm on mousedown and act on
        // mouseup. HTMLElement.click() alone omits both. This remains synthetic,
        // exact-element input, not trusted input or coordinate-based targeting.
        const send = (type, EventClass, buttons) => {
          check();
          return el.dispatchEvent(
            new EventClass(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 0,
              buttons,
              detail: 1,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
            }),
          );
        };
        const mouse = send("pointerdown", PointerEvent, 1);
        if (mouse && send("mousedown", MouseEvent, 1)) {
          check();
          el.focus({ preventScroll: true });
        }
        send("pointerup", PointerEvent, 0);
        if (mouse) send("mouseup", MouseEvent, 0);
      }
      // Handlers above can disable, remove or change the destination. Never
      // re-resolve a replacement element or click a newly unsafe destination.
      check();
      el.click();
    };
    if (operation === "fill") {
      const checkFill = () => {
        check();
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
      };
      checkFill();
      state.refs.clear();
      const proto =
        el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, args.text);
      checkFill();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      checkFill();
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (operation === "select") {
      const checkSelect = () => {
        check();
        if (
          !(el instanceof HTMLSelectElement) ||
          el.disabled ||
          ![...el.options].some((o) => o.value === args.value && !o.disabled)
        )
          fail();
      };
      checkSelect();
      state.refs.clear();
      el.value = args.value;
      checkSelect();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      checkSelect();
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (operation === "key") {
      // Exact-element semantic activation only: no browser/global shortcuts or
      // arbitrary typing into the focused element.
      const checkKey = () => {
        check();
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
      };
      checkKey();
      if (
        (args.key === "Enter" || args.key === "Space") &&
        el.matches("button,[role=button]")
      )
        activate();
      else {
        state.refs.clear();
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: args.key === "Space" ? " " : args.key,
            bubbles: true,
          }),
        );
        checkKey();
        el.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: args.key === "Space" ? " " : args.key,
            bubbles: true,
          }),
        );
      }
    } else if (operation === "click") {
      activate();
    } else fail();
    state.refs.clear();
    return { ok: true };
  } catch {
    return { observationBlocked: failure ?? "unsupported_operation" };
  }
}
