import { describe, expect, test } from "bun:test";
import {
  AX_DIFF_HEADER,
  AX_NO_CHANGE,
  dialogControlFor,
  dialogSnapshotNodes,
  identityFor,
  isSettable,
  renderRevision,
  stripUrl,
  urlCap,
  type AXInputNode,
  type AXRevision,
  type AXSnapshot,
  type RenderOptions,
} from "../src/server/browser/ax-render";

// Expected strings below were checked against the Codex renderer on the same input.

function page(title = "Test page", url = "https://example.com/") {
  const nodes: AXInputNode[] = [];
  const add = (parentIndex: number, role: string, name: string | null = null, extra: Partial<AXInputNode> = {}) => {
    nodes.push({ parentIndex, identity: `n${nodes.length}`, role, name, description: null, value: null, properties: {}, ...extra });
    return nodes.length - 1;
  };
  return { nodes, add, snap: (): AXSnapshot => ({ tab: { id: 7, title, url }, nodes }) };
}

const full: RenderOptions = { mode: "full", documentKey: "doc" };
const auto: RenderOptions = { mode: "auto", documentKey: "doc" };
const render = (s: AXSnapshot) => renderRevision(s, null, full).text;
const lines = (text: string) => text.split("\n");

describe("full tree format", () => {
  test("renders the Codex VoiceOver-style tree with root line and focus footer", () => {
    const b = page();
    const A = b.add;
    const r = A(-1, "RootWebArea", "Test page", { properties: { focused: true } });
    const g = A(r, "generic");
    const h = A(g, "heading", "Hello world", { properties: { level: 1 } });
    A(h, "StaticText", "Hello world");
    const l = A(g, "link", "Docs", { properties: { url: "https://www.example.com/docs?x=1" } });
    A(l, "StaticText", "Docs");
    A(g, "textbox", "Email", { value: "a@b.c", properties: { settable: true, placeholder: "you@example.com" }, dom: { id: "email", tagName: "input" } });
    const bt = A(g, "button", "Submit");
    A(bt, "StaticText", "Submit");
    A(g, "checkbox", "Remember me", { properties: { checked: "false" } });
    A(g, "combobox", "Country", { value: "UK", properties: { expanded: false } });
    A(g, "image", "Logo");
    const ul = A(g, "list");
    for (const t of ["one", "two"]) A(A(ul, "listitem"), "StaticText", t);
    expect(render(b.snap())).toBe(
      [
        "0 AXWebArea Test page, URL: example.com/",
        "\t1 container",
        "\t\t2 heading Hello world, Value: 1",
        "\t\t\t3 text Hello world",
        "\t\t4 link Description: Docs, Value: example.com/docs?x=1",
        "\t\t5 text field (settable) Email, Value: a@b.c, Placeholder: you@example.com, ID: email",
        "\t\t6 button Submit",
        "\t\t7 checkbox Remember me, Value: 0",
        "\t\t8 combo box (collapsed) Country, Value: UK, Secondary Actions: Expand",
        "\t\t9 image Logo",
        "\t\t10 content list",
        "\t\t\t11 text one",
        "\t\t\t12 text two",
        "",
        "The focused UI element is 0 AXWebArea Test page, URL: example.com/",
      ].join("\n"),
    );
  });

  test("without a focused element there is no footer and the text ends with a newline", () => {
    const b = page();
    const r = b.add(-1, "RootWebArea", "P");
    b.add(r, "button", "Go");
    expect(render(b.snap())).toBe("0 AXWebArea P, URL: example.com/\n\t1 button Go\n");
  });

  test("role words", () => {
    const b = page();
    const A = b.add;
    const r = A(-1, "RootWebArea", "P");
    for (const role of ["navigation", "region", "dialog", "list", "listbox", "table", "row", "cell", "columnheader", "radio", "switch", "slider", "spinbutton", "progressbar", "separator", "searchbox", "menubar", "tablist", "toolbar", "tree", "treeitem", "DescriptionList", "menuitem", "option", "img", "Canvas", "ListMarker", "meter", "scrollbar", "Date", "InputTime", "ColorWell", "LabelText", "paragraph"])
      A(r, role, `N ${role}`);
    A(r, "button", "Menu", { properties: { hasPopup: "menu" } });
    A(r, "button", "Bold", { properties: { pressed: "true" } });
    A(r, "combobox", "Size", { value: "M", properties: { settable: true }, dom: { tagName: "select" } });
    A(r, "textbox", "Notes", { properties: { multiline: true } });
    A(r, "button", "Fancy", { properties: { roledescription: "toggle" } });
    expect(render(b.snap())).toBe(
      "0 AXWebArea P, URL: example.com/\n\t1 container N navigation\n\t2 container N region\n\t3 container N dialog\n\t4 content list N list\n\t5 list N listbox\n\t6 table N table\n\t7 row N row\n\t8 radio button N radio\n\t9 switch N switch\n\t10 slider N slider\n\t11 stepper N spinbutton\n\t12 progress indicator N progressbar\n\t13 splitter N separator\n\t14 search text field N searchbox\n\t15 menu bar N menubar\n\t16 tab group N tablist\n\t17 toolbar N toolbar\n\t18 outline N tree\n\t19 row N treeitem\n\t20 definition list N DescriptionList\n\t21 N menuitem\n\t22 N option\n\t23 container N img\n\t24 image N Canvas\n\t25 AXListMarker N ListMarker\n\t26 level indicator N meter\n\t27 scroll bar N scrollbar\n\t28 date field N Date\n\t29 time field N InputTime\n\t30 color well N ColorWell\n\t31 container N LabelText\n\t32 container N paragraph\n\t33 pop up button Menu\n\t34 checkbox Bold, Value: 1\n\t35 pop up button (settable) Size, Value: M\n\t36 text entry area Notes\n\t37 toggle Fancy\n",
    );
  });

  test("flags in parentheses, value semantics and key order", () => {
    const b = page();
    const A = b.add;
    const r = A(-1, "RootWebArea", "P");
    A(r, "tab", "Tab A", { properties: { selected: true } });
    A(r, "tab", "Tab B", { properties: { selected: false } });
    A(r, "checkbox", "Native", { properties: { checked: "true" }, dom: { tagName: "input" } });
    A(r, "checkbox", "Mixed", { properties: { checked: "mixed" } });
    A(r, "switch", "Wifi", { properties: { checked: "false" }, dom: { tagName: "input" } });
    A(r, "slider", "Volume", { value: 30, properties: { valuetext: "30 percent" }, dom: { tagName: "input" } });
    A(r, "slider", "Zoom", { value: 1.5, dom: { tagName: "input" } });
    A(r, "button", "Off", { properties: { disabled: true } });
    A(r, "button", "More", { properties: { expanded: true, hasPopup: "menu" } });
    A(r, "row", "Row", { properties: { selected: false } });
    A(r, "textbox", "All", {
      value: "VV",
      description: "HH",
      properties: { url: "https://e.com/u", expanded: true, placeholder: "PH", valuetext: "VT", settable: true, selected: true, disabled: true },
      dom: { id: "IDX" },
    });
    expect(lines(render(b.snap())).slice(1, -1)).toEqual([
      "\t1 tab (selected, settable, boolean) Tab A, Value: 1",
      "\t2 tab (selectable, settable, boolean) Tab B, Value: 0",
      "\t3 checkbox (settable, integer) Native, Value: 1",
      "\t4 checkbox Mixed, Value: 2",
      "\t5 switch (settable, boolean) Wifi, Value: 0",
      "\t6 slider (settable, integer) Volume, Value: 30, Details: 30 percent",
      "\t7 slider (settable, float) Zoom, Value: 1.5",
      "\t8 button (disabled) Off",
      "\t9 pop up button (expanded) More, Secondary Actions: Collapse",
      "\t10 row (selectable) Row",
      "\t11 text field (selected, disabled, expanded, settable) All, URL: e.com/u, Help: HH, Value: VV, Details: VT, Placeholder: PH, ID: IDX, Secondary Actions: Collapse",
    ]);
  });

  test("Description: for aria-label names, links and keyed containers; lone keys print bare", () => {
    const b = page();
    const A = b.add;
    const r = A(-1, "RootWebArea", "P");
    A(r, "button", "Close", { nameSource: "attribute" });
    A(r, "button", "Close dialog", { nameSource: "attribute", properties: { expanded: false } });
    A(r, "generic", "Card");
    A(r, "generic", "Card 2", { description: "More info" });
    A(r, "link", "Plain link");
    A(r, "link", null, { properties: { url: "https://e.com/x" } });
    A(r, "heading", "H2", { properties: { level: 2 } });
    A(r, "image", null, { dom: { id: "hero" } });
    A(r, "textbox", null, { value: "typed", properties: { settable: true } });
    A(r, "textbox", "Search", { nameSource: "placeholder", properties: { settable: true, placeholder: "Search" } });
    A(r, "cell", "contents name");
    const g = A(r, "generic", null, { dom: { id: "main-content" } });
    A(g, "button", "x");
    A(g, "button", "y");
    expect(lines(render(b.snap())).slice(1, -1)).toEqual([
      "\t1 button Close",
      "\t2 button (collapsed) Description: Close dialog, Secondary Actions: Expand",
      "\t3 container Card",
      "\t4 container Description: Card 2, Help: More info",
      "\t5 link Plain link",
      "\t6 heading H2, Value: 2",
      "\t7 image hero",
      "\t8 text field (settable) typed",
      "\t9 text field (settable) Search",
      "\t10 container main-content",
      "\t\t11 button x",
      "\t\t12 button y",
    ]);
  });

  test("pruning: wrapper collapsing, text merging, duplicate text, link content, empty nodes", () => {
    const b = page();
    const A = b.add;
    const r = A(-1, "RootWebArea", "P");
    A(A(A(r, "generic"), "generic"), "button", "Deep");
    A(A(r, "generic"), "StaticText", "only text");
    let g = A(r, "paragraph");
    A(g, "StaticText", "alpha ");
    A(g, "StaticText", "beta");
    A(A(g, "emphasis"), "StaticText", "gamma");
    g = A(r, "generic");
    A(g, "StaticText", "line1");
    A(g, "LineBreak", "\n");
    A(g, "StaticText", "line2");
    A(A(r, "button", "Save"), "StaticText", "Save");
    A(A(r, "link", "Read more", { properties: { url: "https://e.com/more" } }), "StaticText", "Read more");
    const outer = A(r, "generic");
    A(outer, "button", "A");
    const inner = A(outer, "generic");
    A(inner, "button", "B1");
    A(inner, "button", "B2");
    g = A(r, "generic");
    A(g, "image");
    A(g, "image");
    A(r, "generic");
    A(r, "button");
    expect(render(b.snap())).toBe(
      [
        "0 AXWebArea P, URL: example.com/",
        "\t1 button Deep",
        "\t2 text only text",
        "\t3 container",
        "\t\t4 text alpha  beta gamma",
        "\t5 container",
        "\t\t6 text line1",
        "\t\t7 text line2",
        "\t8 button Save",
        "\t9 link Description: Read more, Value: e.com/more",
        "\t10 container",
        "\t\t11 button A",
        "\t\t12 button B1",
        "\t\t13 button B2",
        "",
      ].join("\n"),
    );
  });

  test("tables drop empty rows and columns", () => {
    const b = page();
    const A = b.add;
    const r = A(-1, "RootWebArea", "P");
    const t = A(r, "table", "Prices");
    const hr = A(t, "row");
    for (const h of ["Name", "", "Price"]) {
      const c = A(hr, "columnheader", h || null);
      if (h) A(c, "StaticText", h);
    }
    for (let i = 0; i < 2; i++) {
      const row = A(t, "row");
      for (const v of [`Item ${i}`, "", `$${i}`]) {
        const c = A(row, "cell", v || null);
        if (v) A(c, "StaticText", v);
      }
    }
    const empty = A(t, "row");
    for (let j = 0; j < 3; j++) A(empty, "cell");
    const text = render(b.snap());
    expect(text).toBe(
      "0 AXWebArea P, URL: example.com/\n\t1 table Prices\n\t\t2 row\n\t\t\t3 cell\n\t\t\t\t4 text Name\n\t\t\t5 cell\n\t\t\t\t6 text Price\n\t\t7 row\n\t\t\t8 cell\n\t\t\t\t9 text Item 0\n\t\t\t10 cell\n\t\t\t\t11 text $0\n\t\t12 row\n\t\t\t13 cell\n\t\t\t\t14 text Item 1\n\t\t\t15 cell\n\t\t\t\t16 text $1\n",
    );
  });

  test("selected tabs read their content into the line (multi-line values move last)", () => {
    const b = page();
    const A = b.add;
    const tl = A(A(-1, "RootWebArea", "P"), "tablist");
    for (const [n, s] of [["Recent", true], ["Starred", false]] as const) A(A(A(tl, "tab", n, { properties: { selected: s } }), "generic"), "StaticText", n);
    expect(render(b.snap())).toBe(
      "0 AXWebArea P, URL: example.com/\n\t1 tab group\n\t\t2 tab (selected, settable, boolean) Recent, Value: 1\nRecent\n\t\t3 tab (selectable, settable, boolean) Starred, Value: 0\nStarred\n",
    );
  });

  test("caps each parent at 500 children", () => {
    const b = page();
    const r = b.add(-1, "RootWebArea", "P");
    for (let k = 0; k < 501; k++) b.add(r, "button", `b${k}`);
    const ls = lines(render(b.snap()));
    expect(ls[0]).toBe("0 AXWebArea P, URL: example.com/ (showing 0-500 of 501 items)");
    expect(ls.filter((l) => l.startsWith("\t")).length).toBe(500);
    expect(ls).toContain("\t500 button b499");

    const c = page();
    const r2 = c.add(-1, "RootWebArea", "P");
    for (let k = 0; k < 500; k++) c.add(r2, "button", `b${k}`);
    expect(lines(render(c.snap()))[0]).toBe("0 AXWebArea P, URL: example.com/");
  });

  test("caps depth at 200", () => {
    for (const [n, leaf] of [[199, true], [200, false]] as const) {
      const b = page();
      let p = b.add(-1, "RootWebArea", "P");
      for (let k = 0; k < n; k++) p = b.add(p, "group", `G${k}`);
      b.add(p, "button", "leaf");
      const ls = lines(render(b.snap())).filter((l) => /^\t*\d+ /.test(l));
      expect(Math.max(...ls.map((l) => /^\t*/.exec(l)![0].length))).toBe(200);
      expect(ls.some((l) => l.includes("button leaf"))).toBe(leaf);
    }
  });

  test("names containing newlines continue on the next physical line", () => {
    const b = page();
    b.add(b.add(-1, "RootWebArea", "P"), "StaticText", "multi\nline");
    expect(render(b.snap())).toBe("0 AXWebArea P, URL: example.com/\n\t1 text multi\nline\n");
  });
});

describe("URLs", () => {
  test("strip http(s) and www., keep other schemes, drop data: and relative URLs", () => {
    expect(stripUrl("https://www.example.com/x?y=1#z")).toBe("example.com/x?y=1#z");
    expect(stripUrl("http://localhost:3000/foo")).toBe("localhost:3000/foo");
    expect(stripUrl("ftp://www.x.org/f")).toBe("ftp://x.org/f");
    expect(stripUrl("https://user:pw@www.e.com/p")).toBe("user:pw@e.com/p");
    expect(stripUrl("https://www2.e.com/")).toBe("www2.e.com/");
    expect(stripUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(stripUrl("javascript:void(0)")).toBe("javascript:void(0)");
    expect(stripUrl("https://e.com/q?a b")).toBe("e.com/q?a%20b");
    expect(stripUrl("data:text/plain,hi")).toBeNull();
    expect(stripUrl("/relative")).toBeNull();
    expect(stripUrl("www.e.com/x")).toBeNull();
  });

  test("cap formula: full under budget, water-filled cap over it, 20-char floor", () => {
    expect(urlCap([100, 200, 300])).toBe(Infinity);
    expect(urlCap(Array(40).fill(157))).toBe(100);
    expect(urlCap(Array(130).fill(157))).toBe(30);
    expect(urlCap(Array(500).fill(157))).toBe(20);
    // Short URLs keep their length; the cap only bites on long ones.
    expect(urlCap([...Array(30).fill(10), ...Array(30).fill(300)])).toBe(123);
  });

  function links(n: number) {
    const b = page("Page", `https://example.com/${"q".repeat(150)}`);
    const r = b.add(-1, "RootWebArea", "Page");
    for (let k = 0; k < n; k++)
      b.add(r, "link", `Link number ${k}`, { properties: { url: `https://example.com/some/long/path/segment/${k}/${"abcdefghij".repeat(12)}` } });
    return lines(render(b.snap()));
  }

  test("link-heavy pages shorten URLs adaptively", () => {
    const few = links(10);
    expect(few[1]).toBe(`\t1 link Description: Link number 0, Value: example.com/some/long/path/segment/0/${"abcdefghij".repeat(12)}`);
    expect(few[0]).toBe(`0 AXWebArea Page, URL: example.com/${"q".repeat(150)}`);

    const many = links(200);
    expect(many[1]).toBe("\t1 link Description: Link number 0, Value: example.com/some/lo…");
    expect(many[0]).toBe("0 AXWebArea Page, URL: example.com/qqqqqqq…");

    const lots = links(250);
    expect(lots[201]).toBe("\t201 link Description: Link number 200, Value: …");
    expect(lots[200]).toContain("Value: example.com/some/lo…");
  });
});

describe("focus footer", () => {
  test("a focused link is described with URL:", () => {
    const b = page();
    b.add(b.add(-1, "RootWebArea", "P"), "link", "Account", { properties: { url: "https://dash.example.com/tokens", focused: true } });
    expect(render(b.snap())).toBe(
      "0 AXWebArea P, URL: example.com/\n\t1 link Description: Account, Value: dash.example.com/tokens\n\nThe focused UI element is 1 link Description: Account, URL: dash.example.com/tokens",
    );
  });

  test("a focused element that is not rendered gets an id of its own", () => {
    const b = page();
    const r = b.add(-1, "RootWebArea", "P");
    b.add(r, "button", "Go");
    b.add(r, "generic", null, { properties: { focused: true } });
    const { text, revision } = renderRevision(b.snap(), null, full);
    expect(text).toBe("0 AXWebArea P, URL: example.com/\n\t1 button Go\n\nThe focused UI element is 2 container");
    expect(identityFor(revision, 2)).toBe("n2");
    expect(revision.focused).toBe(2);
  });
});

describe("diffs", () => {
  function buttons(n: number, changed = 0, width = 10) {
    const b = page("T", "https://e.com/");
    const r = b.add(-1, "RootWebArea", "T");
    for (let k = 0; k < n; k++) b.add(r, "button", (k < changed ? "X" : "B") + String(k).padStart(width, "0"));
    return b.snap();
  }

  test("absolute threshold: a diff must save at least 1000 characters", () => {
    const small = renderRevision(buttons(44), null, auto);
    expect(small.text.length).toBe(1030);
    const again = renderRevision(buttons(44), small.revision, auto);
    expect(again.diff).toBe(false);
    expect(again.text).toBe(small.text);

    const big = renderRevision(buttons(45), null, auto);
    expect(big.text.length).toBe(1053);
    const same = renderRevision(buttons(45), big.revision, auto);
    expect(same.diff).toBe(true);
    expect(same.text).toBe(AX_NO_CHANGE);
  });

  test("relative threshold: a diff must save at least 30%", () => {
    const base = renderRevision(buttons(400), null, auto);
    expect(base.text.length).toBe(9519);
    const diffed = renderRevision(buttons(400, 263), base.revision, auto);
    expect(diffed.diff).toBe(true);
    expect(diffed.text.length).toBe(6640);
    const fullAgain = renderRevision(buttons(400, 264), base.revision, auto);
    expect(fullAgain.diff).toBe(false);
    expect(fullAgain.text.length).toBe(9519);
  });

  test("changed, added and removed elements with absolute indentation", () => {
    const zero = { ...auto, minSavedChars: 0, minSavedRatio: 0 };
    const make = (v2: boolean) => {
      const b = page();
      const A = b.add;
      const nodes = b.nodes;
      const r = A(-1, "RootWebArea", "Test page", { properties: { focused: true } });
      const g = A(r, "generic");
      A(g, "textbox", "Email", { value: v2 ? "new@b.c" : "a@b.c", properties: { settable: true }, dom: { tagName: "input" } });
      A(g, "checkbox", "Remember me", { properties: { checked: v2 ? "true" : "false" } });
      for (let k = 0; k < 6; k++) {
        const idx = A(g, "button", `Button ${k}`);
        nodes[idx]!.identity = `btn${k}`;
        if (v2 && (k === 2 || k === 3 || k === 4)) nodes.pop();
      }
      A(g, "button", "Tail");
      nodes.at(-1)!.identity = "tail";
      for (let k = 0; k < 30; k++) {
        A(g, "button", `filler ${k}`);
        nodes.at(-1)!.identity = `filler${k}`;
      }
      if (v2) {
        const d = A(g, "dialog", "Confirm");
        nodes[d]!.identity = "dlg";
        A(d, "button", "OK");
        nodes.at(-1)!.identity = "ok";
      }
      return b.snap();
    };
    const first = renderRevision(make(false), null, zero);
    expect(first.text).toContain("\t\t6 button Button 2\n\t\t7 button Button 3\n\t\t8 button Button 4\n");
    const second = renderRevision(make(true), first.revision, zero);
    expect(second.diff).toBe(true);
    expect(second.text).toBe(
      [
        AX_DIFF_HEADER,
        "Removed element IDs: 6-8",
        "~\t\t2 text field (settable) Email, Value: new@b.c",
        "~\t\t3 checkbox Remember me, Value: 1",
        "+\t\t41 container Confirm",
        "+\t\t\t42 button OK",
        "The focused UI element is 0 AXWebArea Test page, URL: example.com/",
      ].join("\n"),
    );
    // The revision always holds the full text with stable ids.
    expect(second.revision.text).toContain("\t\t40 button filler 29\n\t\t41 container Confirm\n\t\t\t42 button OK\n");
    const third = renderRevision(make(true), second.revision, zero);
    expect(third.text).toBe(`${AX_NO_CHANGE}\nThe focused UI element is 0 AXWebArea Test page, URL: example.com/`);
  });

  test("range compression and moved elements", () => {
    const zero = { ...auto, minSavedChars: 0, minSavedRatio: 0 };
    const make = (ids: string[], moveLast = false) => {
      const b = page();
      const r = b.add(-1, "RootWebArea", "P");
      const g1 = b.add(r, "group", "G1");
      const g2 = b.add(r, "group", "G2");
      for (const id of ids) {
        b.add(moveLast && id === ids.at(-1) ? g2 : g1, "button", id);
        b.nodes.at(-1)!.identity = id;
      }
      b.nodes[g1]!.identity = "g1";
      b.nodes[g2]!.identity = "g2";
      for (let k = 0; k < 30; k++) {
        b.add(g2, "button", `anchor ${k}`);
        b.nodes.at(-1)!.identity = `anchor${k}`;
      }
      return b.snap();
    };
    const a = renderRevision(make(["a", "b", "c", "d", "e", "f", "g"]), null, zero);
    const b = renderRevision(make(["a", "c", "g"]), a.revision, zero);
    expect(b.text.split("\n")[1]).toBe("Removed element IDs: 3, 5-7");
    const moved = renderRevision(make(["a", "c", "g"], true), b.revision, zero);
    expect(moved.text).toContain("~\t\t8 button g");
    expect(moved.revision.ids.get("g")).toBe(b.revision.ids.get("g"));
  });
});

describe("ids", () => {
  const snap = (names: string[], url = "https://e.com/") => {
    const b = page("T", url);
    const r = b.add(-1, "RootWebArea", "T");
    b.nodes[r]!.identity = "root";
    for (const n of names) {
      b.add(r, "button", n);
      b.nodes.at(-1)!.identity = n;
    }
    return b.snap();
  };

  test("stable by identity, never reused, new ids above the previous maximum", () => {
    const r1 = renderRevision(snap(["a", "b", "c"]), null, auto).revision;
    expect([...r1.ids.entries()]).toEqual([["root", 0], ["a", 1], ["b", 2], ["c", 3]]);
    const r2 = renderRevision(snap(["c", "d"]), r1, auto).revision;
    expect(r2.ids.get("c")).toBe(3);
    expect(r2.ids.get("d")).toBe(4);
    const r3 = renderRevision(snap(["a", "c", "d"]), r2, auto).revision;
    expect(r3.ids.get("a")).toBe(5); // "a" disappeared in r2: it gets a fresh id
    expect(identityFor(r3, 1)).toBeUndefined();
    expect(identityFor(r3, 5)).toBe("a");
  });

  test("mode full keeps ids stable against the previous revision", () => {
    const r1 = renderRevision(snap(["a", "b"]), null, auto).revision;
    const r2 = renderRevision(snap(["b", "z"]), r1, full);
    expect(r2.diff).toBe(false);
    expect(r2.text).toBe("0 AXWebArea T, URL: e.com/\n\t2 button b\n\t3 button z\n");
  });

  test("a new document renders in full and continues numbering", () => {
    const r1 = renderRevision(snap(["a", "b"]), null, auto).revision;
    const r2 = renderRevision(snap(["a", "b"], "https://e.com/next"), r1, { mode: "auto", documentKey: "doc2" });
    expect(r2.diff).toBe(false);
    expect(r2.text).toBe("3 AXWebArea T, URL: e.com/next\n\t4 button a\n\t5 button b\n");
    expect(r2.revision.documentKey).toBe("doc2");
  });

  test("isSettable and identityFor", () => {
    const b = page();
    const r = b.add(-1, "RootWebArea", "P");
    b.add(r, "textbox", "Name", { properties: { settable: true } });
    b.add(r, "checkbox", "Native", { dom: { tagName: "input" }, properties: { checked: "false" } });
    b.add(r, "checkbox", "Aria", { properties: { checked: "false" } });
    b.add(r, "button", "Go");
    const rev: AXRevision = renderRevision(b.snap(), null, full).revision;
    expect([1, 2, 3, 4].map((id) => isSettable(rev, id))).toEqual([true, true, false, false]);
    expect(isSettable(rev, 99)).toBe(false);
    expect(identityFor(rev, 4)).toBe("n4");
  });
});

describe("JavaScript dialogs", () => {
  const tab = { id: 5, title: "My App", url: "https://example.com/x" };

  test("prompt dialog renders like Codex", () => {
    const { text, revision } = renderRevision({ tab, nodes: [], dialog: { type: "prompt", message: "Delete this item?", promptText: "default", id: "7" } }, null, full);
    expect(text).toBe(
      [
        "0 AXWebArea Description: My App, URL: example.com/x",
        "\t1 container example.com says",
        "\t\t2 text Delete this item?",
        "\t\t3 text field (settable) Description: Response, Value: default",
        "\t\t4 button Cancel",
        "\t\t5 button OK",
        "",
        "The focused UI element is 3 text field (settable) Description: Response, Value: default",
      ].join("\n"),
    );
    expect(dialogControlFor(revision, 3)).toBe("prompt");
    expect(dialogControlFor(revision, 4)).toBe("dismiss");
    expect(dialogControlFor(revision, 5)).toBe("accept");
    expect(dialogControlFor(revision, 2)).toBeNull();
    expect(isSettable(revision, 3)).toBe(true);
  });

  test("alert, confirm and beforeunload controls", () => {
    const alert = renderRevision({ tab, nodes: [], dialog: { type: "alert", message: "Saved" } }, null, full).text;
    expect(alert).toBe("0 AXWebArea Description: My App, URL: example.com/x\n\t1 container example.com says\n\t\t2 text Saved\n\t\t3 button OK\n\nThe focused UI element is 3 button OK");
    const confirm = renderRevision({ tab, nodes: [], dialog: { type: "confirm", message: "Sure?" } }, null, full).text;
    expect(confirm).toContain("\t\t3 button Cancel\n\t\t4 button OK\n");
    const leave = renderRevision({ tab, nodes: dialogSnapshotNodes(tab, { type: "beforeunload", message: "" }) }, null, full).text;
    expect(leave).toContain("\t\t2 button Stay\n\t\t3 button Leave\n");
    const nodes = dialogSnapshotNodes(tab, { type: "confirm", message: "x", id: 9 });
    expect(nodes.filter((n) => n.isDialogControl).map((n) => n.identity)).toEqual(["javascript-dialog:5:9:dismiss", "javascript-dialog:5:9:accept"]);
  });
});

test("renders 20k nodes well under 100 ms", () => {
  const nodes: AXInputNode[] = [{ parentIndex: -1, identity: "r", role: "RootWebArea", name: "Big", description: null, value: null, properties: { focused: true } }];
  let section = 0;
  while (nodes.length < 20_000) {
    if (nodes.length % 2000 < 7) {
      nodes.push({ parentIndex: 0, identity: `s${nodes.length}`, role: "region", name: "Section", description: null, value: null, properties: {} });
      section = nodes.length - 1;
    }
    const g = nodes.push({ parentIndex: section, identity: `g${nodes.length}`, role: "generic", name: null, description: null, value: null, properties: {} }) - 1;
    const a = nodes.push({ parentIndex: g, identity: `a${nodes.length}`, role: "link", name: `Item ${g}`, description: null, value: null, properties: { url: `https://www.example.com/items/${g}` } }) - 1;
    nodes.push({ parentIndex: a, identity: `t${nodes.length}`, role: "StaticText", name: `Item ${g}`, description: null, value: null, properties: {} });
    const p = nodes.push({ parentIndex: g, identity: `p${nodes.length}`, role: "paragraph", name: null, description: null, value: null, properties: {} }) - 1;
    nodes.push({ parentIndex: p, identity: `x${nodes.length}`, role: "StaticText", name: `Some text ${g}`, description: null, value: null, properties: {} });
    nodes.push({ parentIndex: g, identity: `b${nodes.length}`, role: "button", name: `Go ${g}`, description: null, value: null, properties: { focusable: true } });
  }
  const snapshot: AXSnapshot = { tab: { id: 1, title: "Big", url: "https://example.com/" }, nodes };
  const first = renderRevision(snapshot, null, auto); // warm-up
  const t0 = performance.now();
  const again = renderRevision(snapshot, first.revision, auto);
  const ms = performance.now() - t0;
  expect(again.text.startsWith(AX_NO_CHANGE)).toBe(true);
  expect(first.revision.order.length).toBeGreaterThan(10_000);
  expect(ms).toBeLessThan(100);
});
