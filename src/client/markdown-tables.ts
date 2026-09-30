export function tableRow(line: string): string[] | null {
  const text = line.trim();
  const cells: string[] = [];
  let cell = "",
    ticks = 0,
    pipes = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\" && i + 1 < text.length) {
      const next = text[++i]!;
      cell += next === "|" ? "|" : "\\" + next;
    } else if (char === "`") {
      let end = i + 1;
      while (text[end] === "`") end++;
      const count = end - i;
      if (ticks === count) ticks = 0;
      else if (!ticks && text.indexOf("`".repeat(count), end) !== -1)
        ticks = count;
      cell += text.slice(i, end);
      i = end - 1;
    } else if (char === "|" && !ticks) {
      cells.push(cell.trim());
      cell = "";
      pipes++;
    } else cell += char;
  }
  if (!pipes) return null;
  cells.push(cell.trim());
  if (cells[0] === "" && text.startsWith("|")) cells.shift();
  if (cells.at(-1) === "" && text.endsWith("|")) cells.pop();
  return cells.length ? cells : null;
}

export function tableHeader(lines: string[], index: number) {
  const headers = tableRow(lines[index] ?? "");
  const separators = tableRow(lines[index + 1] ?? "");
  if (
    !headers ||
    !separators ||
    headers.length !== separators.length ||
    !separators.every((cell) => /^:?-+:?$/.test(cell))
  )
    return null;
  const alignments = separators.map((cell): "left" | "center" | "right" =>
    cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : "left",
  );
  return { headers, alignments };
}
