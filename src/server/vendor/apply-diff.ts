// Adapted from OpenAI openai-agents-js, packages/agents-core/src/utils/applyDiff.ts
// Revision fdaf0a66ca6e9d89498909ad7cf64745630e8afb (MIT; OPENAI-AGENTS-LICENSE).
// Jelly deliberately requires exact, unique, forward-only context/anchors and
// consumes the complete diff. No whitespace fuzz or EOF fallback is permitted.
// Shared by every file, anchor and hunk in one preflight. Charge character
// comparisons as well as iterations so long, similar lines cannot evade it.
export class DiffWorkBudget {
  private remaining = 8_000_000;
  equal(a: string, b: string): boolean {
    this.remaining -= 1 + Math.min(a.length, b.length);
    if (this.remaining < 0) throw new Error("Patch preflight work budget exceeded");
    return a === b;
  }
}
/**
 * Applies a headerless V4A diff to the provided file content.
 * - mode "default": patch an existing file using V4A sections ("@@" + +/-/space lines).
 * - mode "create": create-file syntax that requires every line to start with "+".
 *
 * The function preserves trailing newlines from the original file and throws when
 * the diff cannot be applied cleanly.
 */
export function applyDiff(
  input: string,
  diff: string,
  mode: "default" | "create" = "default",
  budget = new DiffWorkBudget(),
): string {
  const diffLines = normalizeDiffLines(diff);

  if (mode === "create") {
    return parseCreateDiff(diffLines);
  }

  const lineEnding = updateLineEnding(input);
  const normalizedInput =
    lineEnding === "\r\n" ? input.replace(/\r\n/g, "\n") : input;
  const { chunks } = parseUpdateDiff(diffLines, normalizedInput, budget);
  return applyChunks(normalizedInput, chunks, lineEnding);
}

function updateLineEnding(input: string): "\n" | "\r\n" {
  let hasNewline = false;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "\n") continue;
    hasNewline = true;
    if (index === 0 || input[index - 1] !== "\r") {
      return "\n";
    }
  }
  return hasNewline ? "\r\n" : "\n";
}

type Chunk = { origIndex: number; delLines: string[]; insLines: string[] };

type ParserState = { lines: string[]; index: number; fuzz: number };

const END_PATCH = "*** End Patch";
const END_FILE = "*** End of File";
const END_SECTION_MARKERS = [
  END_PATCH,
  "*** Update File:",
  "*** Delete File:",
  "*** Add File:",
  END_FILE,
];

const SECTION_TERMINATORS = [
  END_PATCH,
  "*** Update File:",
  "*** Delete File:",
  "*** Add File:",
];

function normalizeDiffLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""));
}

function isDone(state: ParserState, prefixes: string[]): boolean {
  if (state.index >= state.lines.length) return true;
  if (prefixes.some((p) => state.lines[state.index]?.startsWith(p)))
    return true;
  return false;
}

function readStr(state: ParserState, prefix: string): string {
  const current = state.lines[state.index];
  if (typeof current === "string" && current.startsWith(prefix)) {
    state.index += 1;
    return current.slice(prefix.length);
  }
  return "";
}

function parseCreateDiff(lines: string[]): string {
  const parser: ParserState = {
    lines: [...lines, END_PATCH],
    index: 0,
    fuzz: 0,
  };
  const output: string[] = [];

  while (!isDone(parser, SECTION_TERMINATORS)) {
    const line = parser.lines[parser.index];
    parser.index += 1;
    if (!line.startsWith("+")) {
      throw new Error("Invalid Add File line");
    }
    output.push(line.slice(1));
  }

  return output.join("\n");
}

function parseUpdateDiff(
  lines: string[],
  input: string,
  budget: DiffWorkBudget,
): { chunks: Chunk[]; fuzz: number } {
  const parser: ParserState = {
    lines: [...lines, END_PATCH],
    index: 0,
    fuzz: 0,
  };
  const inputLines = input.split("\n");
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (!isDone(parser, END_SECTION_MARKERS)) {
    const { anchors, anchorCount } = readAnchors(parser);

    if (!(anchorCount > 0 || cursor === 0)) {
      throw new Error("Expected hunk anchor");
    }

    for (const anchor of anchors) {
      cursor = advanceCursorToAnchor(anchor, inputLines, cursor, budget);
    }

    const { nextContext, sectionChunks, endIndex, eof } = readSection(
      parser.lines,
      parser.index,
    );
    const { newIndex, fuzz } = findContext(
      inputLines,
      nextContext,
      cursor,
      eof,
      budget,
    );

    if (newIndex === -1) {
      if (eof) {
        throw new Error(
          `EOF context does not match at or after line ${cursor + 1}`,
        );
      }
      throw new Error(`Context does not match at or after line ${cursor + 1}`);
    }

    parser.fuzz += fuzz;
    for (const ch of sectionChunks) {
      chunks.push({ ...ch, origIndex: ch.origIndex + newIndex });
    }

    cursor = newIndex + nextContext.length;
    parser.index = endIndex;
  }

  if (parser.index !== lines.length)
    throw new Error("Unconsumed or malformed diff");
  if (!chunks.length) throw new Error("Update contains no changes");
  return { chunks, fuzz: parser.fuzz };
}

function readAnchors(parser: ParserState): {
  anchors: string[];
  anchorCount: number;
} {
  const anchors: string[] = [];
  let anchorCount = 0;

  while (true) {
    const startIndex = parser.index;
    const anchor = readStr(parser, "@@ ");
    const textual = parser.index !== startIndex;
    let consumed = textual;

    if (!consumed && parser.lines[parser.index] === "@@") {
      parser.index += 1;
      consumed = true;
    }

    if (!consumed) break;
    anchorCount += 1;
    if (textual) anchors.push(anchor);
  }

  return { anchors, anchorCount };
}

function advanceCursorToAnchor(
  anchor: string,
  inputLines: string[],
  cursor: number,
  budget: DiffWorkBudget,
): number {
  const matches: number[] = [];
  for (let i = cursor; i < inputLines.length; i++) {
    if (budget.equal(inputLines[i], anchor)) matches.push(i);
  }
  if (matches.length !== 1) throw new Error("Anchor must match exactly once");
  return matches[0] + 1;
}

function readSection(
  lines: string[],
  startIndex: number,
): {
  nextContext: string[];
  sectionChunks: Chunk[];
  endIndex: number;
  eof: boolean;
} {
  const context: string[] = [];
  let delLines: string[] = [];
  let insLines: string[] = [];
  const sectionChunks: Chunk[] = [];
  let mode: "keep" | "add" | "delete" = "keep";
  let index = startIndex;
  const origIndex = index;

  while (index < lines.length) {
    const raw = lines[index];
    if (
      raw.startsWith("@@") ||
      raw.startsWith(END_PATCH) ||
      raw.startsWith("*** Update File:") ||
      raw.startsWith("*** Delete File:") ||
      raw.startsWith("*** Add File:") ||
      raw.startsWith(END_FILE)
    ) {
      break;
    }
    if (raw === "***") break;
    if (raw.startsWith("***")) {
      throw new Error("Invalid diff line");
    }

    index += 1;
    const lastMode: "keep" | "add" | "delete" = mode;
    let line = raw;
    if (line === "") throw new Error("Empty diff line requires a prefix");

    if (line[0] === "+") {
      mode = "add";
    } else if (line[0] === "-") {
      mode = "delete";
    } else if (line[0] === " ") {
      mode = "keep";
    } else {
      throw new Error("Invalid diff line");
    }

    line = line.slice(1);

    const switchingToContext = mode === "keep" && lastMode !== mode;
    if (switchingToContext && (insLines.length || delLines.length)) {
      sectionChunks.push({
        origIndex: context.length - delLines.length,
        delLines,
        insLines,
      });
      delLines = [];
      insLines = [];
    }

    if (mode === "delete") {
      delLines.push(line);
      context.push(line);
    } else if (mode === "add") {
      insLines.push(line);
    } else {
      context.push(line);
    }
  }

  if (insLines.length || delLines.length) {
    sectionChunks.push({
      origIndex: context.length - delLines.length,
      delLines,
      insLines,
    });
    delLines = [];
    insLines = [];
  }

  if (index < lines.length && lines[index] === END_FILE) {
    index += 1;
    return { nextContext: context, sectionChunks, endIndex: index, eof: true };
  }

  if (index === origIndex) {
    throw new Error("Empty hunk");
  }

  return { nextContext: context, sectionChunks, endIndex: index, eof: false };
}

function findContext(
  lines: string[],
  context: string[],
  start: number,
  eof: boolean,
  budget: DiffWorkBudget,
): { newIndex: number; fuzz: number } {
  const searchLines = lines;
  const searchLength = lines.length - (lines.at(-1) === "" ? 1 : 0);
  if (!context.length) {
    if (eof) return { newIndex: searchLength, fuzz: 0 };
    if (searchLength && start === 0)
      throw new Error("Insertion requires context, an anchor, or End of File");
    return { newIndex: start, fuzz: 0 };
  }
  if (eof) {
    const at = searchLength - context.length;
    return {
      newIndex:
        at >= start && context.every((line, i) => budget.equal(searchLines[at + i], line))
          ? at
          : -1,
      fuzz: 0,
    };
  }
  // Linear-time exact matching avoids quadratic scans of repetitive files.
  const prefix = new Array<number>(context.length).fill(0);
  for (let i = 1, j = 0; i < context.length; i++) {
    while (j && !budget.equal(context[i], context[j])) j = prefix[j - 1];
    if (budget.equal(context[i], context[j])) j++;
    prefix[i] = j;
  }
  let match = -1;
  for (let i = start, j = 0; i < searchLength; i++) {
    while (j && !budget.equal(searchLines[i], context[j])) j = prefix[j - 1];
    if (budget.equal(searchLines[i], context[j])) j++;
    if (j === context.length) {
      if (match !== -1)
        throw new Error("Ambiguous context: include more surrounding lines");
      match = i - context.length + 1;
      j = prefix[j - 1];
    }
  }
  return { newIndex: match, fuzz: 0 };
}

function applyChunks(
  input: string,
  chunks: Chunk[],
  lineEnding: "\n" | "\r\n",
): string {
  const origLines = input.split("\n");
  const destLines: string[] = [];
  let origIndex = 0;
  let previousChunkIndex = -1;

  for (const chunk of chunks) {
    if (chunk.origIndex === previousChunkIndex) {
      throw new Error("Conflicting hunks at the same original position");
    }
    previousChunkIndex = chunk.origIndex;
    if (chunk.origIndex > origLines.length) {
      throw new Error(
        `applyDiff: chunk.origIndex ${chunk.origIndex} > input length ${origLines.length}`,
      );
    }
    if (origIndex > chunk.origIndex) {
      throw new Error(
        `applyDiff: overlapping chunk at ${chunk.origIndex} (cursor ${origIndex})`,
      );
    }

    for (let i = origIndex; i < chunk.origIndex; i++)
      destLines.push(origLines[i]);
    origIndex = chunk.origIndex;

    if (chunk.insLines.length) {
      for (const line of chunk.insLines) destLines.push(line);
    }

    origIndex += chunk.delLines.length;
  }

  for (let i = origIndex; i < origLines.length; i++)
    destLines.push(origLines[i]);
  const result = destLines.join(lineEnding);
  return result;
}
