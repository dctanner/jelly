/**
 * Worker side of the `browser_js` REPL (plans/codex-style-browser.md §4).
 *
 * Runs inside a Bun `Worker` so the host can terminate a hung cell. Model code runs in a persistent
 * `node:vm` context whose globals are `browser`, `display`, `nodeRepl`, `console`, `sleep`, timers,
 * `require`, `fetch`, ... Each cell is parsed with acorn and rewritten (see `transformCell`) so
 * top-level declarations become properties of the context global and top-level `await` works.
 */
import vm from "node:vm";
import util from "node:util";
import { createRequire } from "node:module";
import { isMainThread } from "node:worker_threads";
import { parse, type Node, type Pattern, type Program } from "acorn";
import { createBrowserApi } from "./client-api";

export const MAX_ITEM_CHARS = 100_000;

export type OutputItem =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

/** host → worker */
export type HostToWorker =
  | { type: "run"; runId: number; code: string }
  | { type: "result"; id: number; result?: unknown; error?: string };

/** worker → host */
export type WorkerToHost =
  | { type: "output"; runId: number; item: OutputItem }
  | { type: "done"; runId: number; error?: string }
  | { type: "call"; id: number; op: string; args: Record<string, unknown> };

// ---------------------------------------------------------------------------------------------
// Cell transform

export interface TransformedCell {
  /** Script source: an async IIFE evaluating to a promise of the final expression value. */
  code: string;
  /** Top-level binding names the cell declares (pre-defined on the context global). */
  names: string[];
  /** Number of user source lines (frames below this point at the wrapper and are dropped). */
  lines: number;
  /** Characters inserted before the user's first line (subtracted from line-1 columns). */
  prefixLength: number;
}

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "script",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowHashBang: true,
} as const;

function patternNames(
  pattern: Pattern | null | undefined,
  out: string[],
): void {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties)
        patternNames(
          prop.type === "RestElement" ? prop.argument : prop.value,
          out,
        );
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternNames(element, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    default:
      break;
  }
}

/** Parse like an object literal when the cell is `{ ... }` and that parses (Node REPL behaviour). */
function parseCell(source: string): { program: Program; source: string } {
  if (/^\s*\{/.test(source) && /\}\s*;?\s*$/.test(source)) {
    const wrapped = `(${source.replace(/;\s*$/, "")})`;
    try {
      const program = parse(wrapped, PARSE_OPTIONS);
      if (
        program.body.length === 1 &&
        program.body[0]!.type === "ExpressionStatement"
      )
        return { program, source: wrapped };
    } catch {
      // not an object literal; parse as statements
    }
  }
  return { program: parse(source, PARSE_OPTIONS), source };
}

/**
 * Rewrite one cell so its top-level bindings persist on the context global (Node REPL style):
 * - `const/let/var a = 1, {b} = o` → `;(a = 1), ({b} = o)` (bindings are context globals; `let x;` resets x)
 * - `class A {}` → `;A = class A {};`
 * - `function f() {}` stays (hoisted inside the cell) and `globalThis.f = f` runs first
 * - a final expression statement becomes `return (expr)`
 * - the whole cell is wrapped in `(async () => { ... })()` so top-level `await` works.
 * Line numbers are preserved (all inserted text stays on existing lines) so stack frames map back.
 * Re-declaring an existing name overwrites it (no "already declared" error); `const` is not
 * immutable across cells. Declarations nested in blocks (including `for (var ...)`) stay cell-local.
 */
export function transformCell(input: string): TransformedCell {
  const { program, source } = parseCell(input);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const names: string[] = [];
  const hoisted: string[] = [];
  const insert = (pos: number, text: string) =>
    edits.push({ start: pos, end: pos, text });
  const body = program.body as Node[];
  body.forEach((statement, index) => {
    if (statement.type === "VariableDeclaration") {
      const decl = statement as unknown as import("acorn").VariableDeclaration;
      const first = decl.declarations[0]!;
      const removed = source.slice(decl.start, first.start);
      edits.push({
        start: decl.start,
        end: first.start,
        text: ";" + removed.replace(/[^\n]/g, ""),
      });
      for (const declarator of decl.declarations) {
        patternNames(declarator.id, names);
        insert(declarator.start, "(");
        insert(
          declarator.end,
          (declarator.init || decl.kind === "var" ? "" : " = undefined") + ")",
        );
      }
    } else if (statement.type === "ClassDeclaration") {
      const decl = statement as unknown as import("acorn").ClassDeclaration;
      names.push(decl.id.name);
      insert(decl.start, `;${decl.id.name} = `);
      insert(decl.end, ";");
    } else if (statement.type === "FunctionDeclaration") {
      const decl = statement as unknown as import("acorn").FunctionDeclaration;
      names.push(decl.id.name);
      hoisted.push(
        `globalThis[${JSON.stringify(decl.id.name)}] = ${decl.id.name};`,
      );
    } else if (
      index === body.length - 1 &&
      statement.type === "ExpressionStatement"
    ) {
      // Use the statement range (not the expression's) so a parenthesised expression stays intact.
      const end =
        source[statement.end - 1] === ";" ? statement.end - 1 : statement.end;
      insert(statement.start, "return (");
      insert(end, ")");
    }
  });
  // Apply from the end so earlier offsets stay valid; at equal positions keep insertion order.
  const ordered = edits.map((edit, order) => ({ ...edit, order }));
  ordered.sort((a, b) => b.start - a.start || b.order - a.order);
  let out = source;
  for (const edit of ordered)
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  const prefix = `(async () => {${hoisted.join(" ")}`;
  return {
    code: `${prefix}${out}\n})()`,
    names: [...new Set(names)],
    lines: source.split("\n").length,
    prefixLength: prefix.length + (source === input ? 0 : 1),
  };
}

// ---------------------------------------------------------------------------------------------
// Formatting

export function truncateText(text: string, max = MAX_ITEM_CHARS): string {
  return text.length > max
    ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]`
    : text;
}

const INSPECT_OPTIONS: util.InspectOptions = {
  depth: 5,
  breakLength: 120,
  compact: 3,
  maxArrayLength: 200,
  maxStringLength: 20_000,
};

export function inspectValue(value: unknown): string {
  return util.inspect(value, INSPECT_OPTIONS);
}

function bytesToBase64(bytes: ArrayBufferView): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}

/** Convert a displayed value into an output item: images for `{data, mimeType:"image/*"}`. */
export function toOutputItem(value: unknown): OutputItem {
  if (typeof value === "string") {
    const dataUrl = /^data:(image\/[\w.+-]+);base64,/.exec(value);
    if (dataUrl)
      return {
        type: "image",
        mimeType: dataUrl[1]!,
        data: value.slice(dataUrl[0].length),
      };
    return { type: "text", text: truncateText(value) };
  }
  if (value && typeof value === "object") {
    const candidate = value as { data?: unknown; mimeType?: unknown };
    if (
      typeof candidate.mimeType === "string" &&
      candidate.mimeType.startsWith("image/")
    ) {
      if (typeof candidate.data === "string")
        return {
          type: "image",
          mimeType: candidate.mimeType,
          data: candidate.data,
        };
      if (ArrayBuffer.isView(candidate.data))
        return {
          type: "image",
          mimeType: candidate.mimeType,
          data: bytesToBase64(candidate.data),
        };
    }
  }
  return { type: "text", text: truncateText(inspectValue(value)) };
}

/** `Name: message` plus only the stack frames inside the cell (`cell.file`), with line-1 columns fixed. */
function describeThrown(
  error: unknown,
  cell?: { file: string; lines: number; prefixLength: number },
): string {
  if (error && typeof error === "object" && "message" in error) {
    const err = error as { name?: unknown; message?: unknown; stack?: unknown };
    const head = `${String(err.name ?? "Error")}: ${String(err.message)}`;
    const frames: string[] = [];
    for (const raw of String(err.stack ?? "").split("\n")) {
      if (!/^\s*at /.test(raw)) continue;
      if (!cell) continue;
      const match = new RegExp(`${cell.file}:(\\d+):(\\d+)`).exec(raw);
      if (!match) continue;
      const line = Number(match[1]);
      if (line > cell.lines) continue;
      const column =
        line === 1
          ? Math.max(1, Number(match[2]) - cell.prefixLength)
          : Number(match[2]);
      const frame = raw
        .trim()
        .replace(match[0], `${cell.file}:${line}:${column}`);
      frames.push(`    ${frame.replace(/^at <anonymous> \((.*)\)$/, "at $1")}`);
    }
    return [head, ...frames].join("\n");
  }
  return `Uncaught ${inspectValue(error)}`;
}

function describeSyntaxError(error: unknown, source: string): string {
  const err = error as {
    message?: string;
    loc?: { line: number; column: number };
  };
  if (!err.loc) return describeThrown(error);
  const line = source.split("\n")[err.loc.line - 1] ?? "";
  return `SyntaxError: ${err.message}\n${line}\n${" ".repeat(err.loc.column)}^`;
}

// ---------------------------------------------------------------------------------------------
// Worker runtime

if (!isMainThread) startWorker();

function startWorker(): void {
  const port = globalThis as unknown as {
    postMessage(message: WorkerToHost): void;
    onmessage: ((event: MessageEvent<HostToWorker>) => void) | null;
  };
  let currentRun: number | null = null;
  let cellCount = 0;
  let late: OutputItem[] = [];
  let nextCallId = 1;
  const pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: unknown): void }
  >();

  const emit = (item: OutputItem) => {
    if (currentRun === null) late.push(item);
    else port.postMessage({ type: "output", runId: currentRun, item });
  };
  const display = (value: unknown): void => {
    emit(toOutputItem(value));
  };
  const write = (...args: unknown[]): void => {
    emit({ type: "text", text: truncateText(util.format(...args)) });
  };

  const sandbox: Record<string, unknown> = {};
  const context = vm.createContext(sandbox);
  const realmJSON = vm.runInContext("JSON", context) as typeof JSON;
  const RealmError = vm.runInContext("Error", context) as ErrorConstructor;
  const RealmArray = vm.runInContext("Array", context) as ArrayConstructor;
  const toRealm = (value: unknown) =>
    value === undefined ? undefined : realmJSON.parse(JSON.stringify(value));

  const call = (
    op: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const id = nextCallId++;
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args))
      if (value !== undefined) clean[key] = value;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        port.postMessage({ type: "call", id, op, args: clean });
      } catch (error) {
        pending.delete(id);
        reject(
          new RealmError(
            `Cannot send arguments for ${op}: ${String((error as Error)?.message ?? error)}`,
          ),
        );
      }
    });
  };

  const consoleApi = {
    log: write,
    info: write,
    debug: write,
    warn: write,
    error: write,
    trace: write,
    dir: (value: unknown) =>
      emit({ type: "text", text: truncateText(inspectValue(value)) }),
    table: (value: unknown) =>
      emit({ type: "text", text: truncateText(inspectValue(value)) }),
    assert: (condition: unknown, ...args: unknown[]) => {
      if (!condition) write("Assertion failed", ...args);
    },
  };

  Object.assign(sandbox, {
    browser: createBrowserApi({
      call,
      display,
      makeArray: (items) => RealmArray.from(items),
    }),
    display,
    nodeRepl: {
      write: (text: unknown) =>
        emit({ type: "text", text: truncateText(String(text)) }),
    },
    console: consoleApi,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    structuredClone,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    fetch,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    AbortController,
    AbortSignal,
    performance,
    Buffer,
    process,
    require: createRequire(`${process.cwd()}/`),
  });

  process.on("unhandledRejection", (reason) => {
    emit({
      type: "text",
      text: truncateText(
        `Unhandled promise rejection: ${describeThrown(reason)}`,
      ),
    });
  });
  process.on("uncaughtException", (error) => {
    emit({
      type: "text",
      text: truncateText(`Uncaught exception: ${describeThrown(error)}`),
    });
  });

  const runCell = async (runId: number, code: string) => {
    currentRun = runId;
    const filename = `cell-${++cellCount}`;
    if (late.length) {
      const items = late;
      late = [];
      emit({
        type: "text",
        text: "[output from earlier cells' background work]",
      });
      for (const item of items) emit(item);
    }
    let transformed: TransformedCell;
    try {
      transformed = transformCell(code);
    } catch (error) {
      currentRun = null;
      port.postMessage({
        type: "done",
        runId,
        error: describeSyntaxError(error, code),
      });
      return;
    }
    try {
      for (const name of transformed.names)
        if (!Object.prototype.hasOwnProperty.call(sandbox, name))
          sandbox[name] = undefined;
      const value = await vm.runInContext(transformed.code, context, {
        filename,
        importModuleDynamically: ((specifier: string) =>
          import(specifier)) as never,
      });
      if (value !== undefined) display(value);
      currentRun = null;
      port.postMessage({ type: "done", runId });
    } catch (error) {
      currentRun = null;
      const cell = {
        file: filename,
        lines: transformed.lines,
        prefixLength: transformed.prefixLength,
      };
      port.postMessage({
        type: "done",
        runId,
        error: truncateText(describeThrown(error, cell)),
      });
    }
  };

  port.onmessage = (event) => {
    const message = event.data;
    if (message.type === "run") void runCell(message.runId, message.code);
    else if (message.type === "result") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error !== undefined)
        entry.reject(new RealmError(message.error));
      else entry.resolve(toRealm(message.result));
    }
  };
}
