/**
 * Page-side functions run with Runtime.callFunctionOn (`this` = the target node).
 * Kept as plain JS source strings so bundlers/transpilers never inject helpers.
 * Behaviour mirrors Codex's page functions (analysis §3.1–3.7).
 */

const SHARED = String.raw`
const deepHit = (x, y, doc) => {
  let e = (doc || document).elementFromPoint(x, y);
  for (let i = 0; e && e.shadowRoot && i < 32; i++) {
    const inner = e.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === e) break;
    e = inner;
  }
  return e;
};
const up = (n) => n && (n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null);
const within = (n, target) => { for (let c = n, i = 0; c && i < 4096; c = up(c), i++) if (c === target) return true; return false; };
const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role=button], [role=checkbox], [role=combobox], [role=link], [role=listbox], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=radio], [role=slider], [role=spinbutton], [role=switch], [role=tab], [role=textbox], [role=treeitem], [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true]';
const interactiveOf = (n) => { for (let c = n, i = 0; c && i < 4096; c = up(c), i++) if (c.nodeType === 1 && c.matches(INTERACTIVE)) return c; return null; };
const element = (n) => n && (n.nodeType === 1 ? n : n.parentElement);
const hits = (hit, target) => {
  if (!hit) return false;
  if (within(hit, target)) return true;
  const a = interactiveOf(hit), b = interactiveOf(target);
  if (a && a === b) return true;
  if (target.nodeType === 1 && target.tagName === 'LABEL' && target.control && within(hit, target.control)) return true;
  if (hit.tagName === 'LABEL' && hit.control === target) return true;
  if (target.nodeType === 1 && getComputedStyle(target).pointerEvents === 'none' && within(hit, target)) return true;
  return false;
};
const visibleRect = (n) => {
  let rects;
  if (n.nodeType === 3) { const r = document.createRange(); r.selectNodeContents(n); rects = r.getClientRects(); }
  else rects = n.getClientRects();
  let rect = null;
  for (const r of rects) if (r.width > 0 && r.height > 0) { rect = r; break; }
  if (!rect) return null;
  const vv = window.visualViewport;
  const vl = vv ? vv.offsetLeft : 0, vt = vv ? vv.offsetTop : 0;
  const vw = vv ? vv.width : innerWidth, vh = vv ? vv.height : innerHeight;
  const left = Math.max(rect.left, vl), right = Math.min(rect.right, vl + vw);
  const top = Math.max(rect.top, vt), bottom = Math.min(rect.bottom, vt + vh);
  return { rect, left, right, top, bottom, onscreen: right > left && bottom > top };
};
`;

const fn = (body: string) =>
  `function (argument) { const __name = (t) => t; ${SHARED}\n${body}\n}`;

/** → {status:"ok"|"offscreen"|"unpositioned"|"covered", x, y, width, height, coveredBy?} (frame viewport CSS px). */
export const HIT_POINT = fn(String.raw`
  const target = this;
  const node = element(target);
  if (!node || !node.isConnected) return { status: 'detached' };
  const v = visibleRect(target);
  if (!v) return { status: 'unpositioned' };
  const width = v.rect.width, height = v.rect.height;
  if (!v.onscreen) return { status: 'offscreen', width, height };
  const x = (v.left + v.right) / 2, y = (v.top + v.bottom) / 2;
  const hit = deepHit(x, y);
  if (hits(hit, node)) return { status: 'ok', x, y, width, height };
  for (const label of node.labels || []) {
    const lv = visibleRect(label);
    if (!lv || !lv.onscreen) continue;
    const lx = (lv.left + lv.right) / 2, ly = (lv.top + lv.bottom) / 2;
    if (hits(deepHit(lx, ly), label)) return { status: 'ok', x: lx, y: ly, width, height };
  }
  return { status: 'covered', x, y, width, height, coveredBy: hit ? hit.tagName : null };
`);

export const SCROLL_CENTER = fn(String.raw`
  const n = element(this);
  if (n) n.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  return true;
`);

/** Offset of an iframe owner's content box in its own document's viewport. */
export const FRAME_CONTENT_OFFSET = fn(String.raw`
  const r = this.getBoundingClientRect();
  const s = getComputedStyle(this);
  return { x: r.left + this.clientLeft + parseFloat(s.paddingLeft || '0'), y: r.top + this.clientTop + parseFloat(s.paddingTop || '0') };
`);

/** Plain left-click fallback when the target is covered (Codex `qre`). */
export const CLICK_FALLBACK = fn(String.raw`
  let n = element(this);
  const sel = 'a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option]';
  for (let c = n, i = 0; c && i < 4096; c = up(c), i++) if (c.nodeType === 1 && c.matches(sel)) { n = c; break; }
  if (n && n.tagName === 'LABEL' && n.control) n = n.control;
  if (!n) return { status: 'missing' };
  if (n.disabled) return { status: 'disabled' };
  const textLike = (n.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|color|range)$/i.test(n.type)) || n.tagName === 'TEXTAREA' || n.isContentEditable;
  if (textLike) { n.focus({ preventScroll: true }); return { status: 'focused' }; }
  n.click();
  return { status: 'clicked' };
`);

/** → {status:"option"} if `this` is an <option> of a single-select popup <select> (clicks select it directly). */
export const SELECT_OPTION_IF_NATIVE = fn(String.raw`
  const o = this;
  if (!o || o.tagName !== 'OPTION') return { status: 'no' };
  const s = o.closest('select');
  if (!s || s.multiple || s.size > 1) return { status: 'no' };
  if (o.disabled || s.disabled) return { status: 'disabled' };
  if (!o.selected) {
    const setter = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected').set;
    setter.call(o, true);
    s.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { status: 'option' };
`);

/** Focus for keyboard input. → {status:"ok"|"not_focusable", editable} */
export const FOCUS = fn(String.raw`
  let n = element(this);
  if (n && n.tagName === 'LABEL' && n.control) n = n.control;
  if (!n) return { status: 'missing' };
  const active = () => { let a = document.activeElement; for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 32; i++) a = a.shadowRoot.activeElement; return a; };
  if (!within(active(), n)) {
    n.focus({ preventScroll: false });
    if (!within(active(), n)) {
      const inner = n.querySelector && n.querySelector('input,textarea,[contenteditable=""],[contenteditable=true],[tabindex]');
      if (inner) inner.focus();
    }
  }
  const a = active();
  if (!a || (!within(a, n) && !within(n, a))) return { status: 'not_focusable' };
  const editable = a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(a.type));
  if (editable && argument && argument.caretToEnd && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) {
    try { const l = a.value.length; a.setSelectionRange(l, l); } catch {}
  }
  return { status: 'ok', editable };
`);

/** Native-setter value assignment (Codex `oF`). argument = {value} */
export const SET_VALUE = fn(String.raw`
  let n = element(this);
  if (n && n.tagName === 'LABEL' && n.control) n = n.control;
  if (!n) return { status: 'error', message: 'has no element' };
  const value = argument.value;
  const fire = (changed) => { if (!changed) return; n.dispatchEvent(new Event('input', { bubbles: true, composed: true })); n.dispatchEvent(new Event('change', { bubbles: true })); };
  const tag = n.tagName;
  if (tag === 'INPUT' && /^(checkbox|radio)$/i.test(n.type)) {
    const s = String(value).toLowerCase();
    if (!['0', '1', 'true', 'false'].includes(s)) return { status: 'error', message: 'expects 0, 1, true or false' };
    const want = s === '1' || s === 'true';
    n.focus({ preventScroll: true });
    const before = n.checked;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set.call(n, want);
    n.indeterminate = false;
    fire(before !== want);
    return n.checked === want ? { status: 'ok' } : { status: 'error', message: 'rejected value' };
  }
  if (tag === 'SELECT') {
    if (n.multiple) return { status: 'error', message: 'is a multi-select; click its options instead' };
    const opts = [...n.options];
    let o = opts.find((x) => x.value === String(value));
    if (!o) { const m = opts.filter((x) => (x.label || x.text).trim() === String(value).trim()); if (m.length === 1) o = m[0]; }
    if (!o) return { status: 'error', message: 'has no option matching ' + JSON.stringify(String(value)) + '. Options: ' + JSON.stringify(opts.slice(0, 50).map((x) => (x.label || x.text).trim())) };
    if (o.disabled) return { status: 'error', message: 'option is disabled' };
    n.focus({ preventScroll: true });
    const before = n.value;
    Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'selected').set.call(o, true);
    fire(before !== n.value);
    return { status: 'ok' };
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (tag === 'INPUT' && n.type === 'file') return { status: 'error', message: 'is a file input; use tab.setFiles(index, paths)' };
    const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    n.focus({ preventScroll: true });
    const before = n.value;
    setter.call(n, String(value));
    if (n.value !== String(value) && !(tag === 'INPUT' && /^(number|date|time|datetime-local|month|week|color|range)$/i.test(n.type) && n.value !== before)) {
      setter.call(n, before);
      return { status: 'error', message: 'rejected value ' + JSON.stringify(String(value)) };
    }
    fire(before !== n.value);
    return { status: 'ok' };
  }
  if (n.getAttribute('role') === 'tab') return n.getAttribute('aria-selected') === 'true' ? { status: 'ok' } : { status: 'needs-click' };
  if (n.isContentEditable) {
    n.focus({ preventScroll: true });
    n.textContent = String(value);
    n.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: String(value) }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
    return { status: 'ok' };
  }
  return { status: 'error', message: 'has no settable value (custom controls: click or type instead)' };
`);

/** argument = {text, prefix?, suffix?, selectionType?: "text"|"cursor_before"|"cursor_after"} */
export const SELECT_TEXT = fn(String.raw`
  const n = element(this);
  const { text, prefix = '', suffix = '', selectionType = 'text' } = argument;
  const needle = prefix + text + suffix;
  const pick = (hay) => {
    const first = hay.indexOf(needle);
    if (first < 0) return { error: 'text not found' };
    if (hay.indexOf(needle, first + 1) >= 0) return { error: 'text occurs more than once; add prefix/suffix to disambiguate' };
    const start = first + prefix.length, end = start + text.length;
    return selectionType === 'cursor_before' ? { start, end: start } : selectionType === 'cursor_after' ? { start: end, end } : { start, end };
  };
  if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') {
    const p = pick(n.value);
    if (p.error) return { status: 'error', message: p.error };
    n.focus({ preventScroll: true });
    n.setSelectionRange(p.start, p.end);
    return { status: 'ok' };
  }
  const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
  const parts = []; let all = '';
  for (let t = walker.nextNode(); t; t = walker.nextNode()) { parts.push([t, all.length]); all += t.data; }
  const p = pick(all);
  if (p.error) return { status: 'error', message: p.error };
  const locate = (offset) => { for (let i = parts.length - 1; i >= 0; i--) if (parts[i][1] <= offset) return [parts[i][0], offset - parts[i][1]]; return [n, 0]; };
  const range = document.createRange();
  const [sn, so] = locate(p.start), [en, eo] = locate(p.end);
  range.setStart(sn, so); range.setEnd(en, eo);
  if (n.isContentEditable) n.focus({ preventScroll: true });
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  return { status: 'ok' };
`);

/** Synthetic paste into the focused element (virtual clipboard). argument = {text, html?} */
export const PASTE = fn(String.raw`
  let a = document.activeElement;
  for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 32; i++) a = a.shadowRoot.activeElement;
  const target = a || document.body;
  const dt = new DataTransfer();
  dt.setData('text/plain', argument.text);
  if (argument.html) dt.setData('text/html', argument.html);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
  const proceed = target.dispatchEvent(ev);
  if (!proceed) return { status: 'handled' };
  const ok = document.execCommand('insertText', false, argument.text);
  return { status: ok ? 'inserted' : 'not_inserted' };
`);

/** Text of the current selection or focused field selection (virtual clipboard copy). */
export const SELECTION_TEXT = fn(String.raw`
  let a = document.activeElement;
  for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 32; i++) a = a.shadowRoot.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && typeof a.selectionStart === 'number')
    return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection());
`);

export const PAGE_PROBE = `(() => ({ readyState: document.readyState, elements: document.body ? document.body.querySelectorAll('*').length : 0, textLength: document.body ? document.body.innerText.length : 0 }))()`;
export const NAV_PROBE = `(() => ({ readyState: document.readyState, painted: performance.getEntriesByType('paint').length > 0, href: location.href }))()`;
