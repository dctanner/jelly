import { Fragment, type ReactNode } from "react";
import { GeneratedImages } from "./GeneratedImages";
import { tableHeader, tableRow } from "./markdown-tables";
import { isGeneratedImageUrl } from "../shared/generated-images";
/** A small, safe renderer: model text never becomes HTML or executable markup. */
function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g)
    .map((part, i) =>
      part.startsWith("`") ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : part.startsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/) ? (
        (() => {
          const m = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)!;
          return (
            <a key={i} href={m[2]} target="_blank" rel="noopener noreferrer">
              {m[1]}
            </a>
          );
        })()
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
}
export function MessageText({ text }: { text: string }) {
  const lines = text.split("\n"),
    blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const table = tableHeader(lines, i);
    const image = line.match(/^!\[([^\]\n]*)\]\((\/api\/images\/[^\s)]+)\)$/);
    if (image && isGeneratedImageUrl(image[2])) {
      blocks.push(
        <GeneratedImages
          key={`image-${i}`}
          images={[{ url: image[2], alt: image[1] }]}
        />,
      );
      i++;
    } else if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```"))
        code.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push(
        <div className="code-block" key={i}>
          {language && <small>{language}</small>}
          <pre>
            <code>{code.join("\n")}</code>
          </pre>
        </div>,
      );
    } else if (table) {
      const start = i;
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const cells = tableRow(lines[i]!);
        if (!cells || /^\s*(```|#{1,3} |[-*] |\d+\. )/.test(lines[i]!)) break;
        rows.push(cells);
        i++;
      }
      blocks.push(
        <div
          className="markdown-table-scroll"
          key={`table-${start}`}
          tabIndex={0}
          role="region"
          aria-label="Table, scroll horizontally for more columns"
        >
          <table>
            <thead>
              <tr>
                {table.headers.map((header, column) => (
                  <th
                    key={column}
                    scope="col"
                    style={{ textAlign: table.alignments[column] }}
                  >
                    {inline(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, row) => (
                <tr key={row}>
                  {table.headers.map((_, column) => (
                    <td
                      key={column}
                      style={{ textAlign: table.alignments[column] }}
                    >
                      {inline(cells[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^#{1,3} /.test(line)) {
      const text = line.replace(/^#{1,3} /, "");
      blocks.push(<h3 key={i}>{inline(text)}</h3>);
      i++;
    } else if (/^\s*[-*] /.test(line) || /^\d+\. /.test(line)) {
      const ordered = /^\d+\./.test(line),
        items: ReactNode[] = [];
      while (
        i < lines.length &&
        (ordered ? /^\d+\. / : /^\s*[-*] /).test(lines[i]!)
      ) {
        items.push(
          <li key={i}>
            {inline(lines[i++]!.replace(ordered ? /^\d+\. / : /^\s*[-*] /, ""))}
          </li>,
        );
      }
      blocks.push(
        ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>,
      );
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [line];
      i++;
      while (
        i < lines.length &&
        lines[i]!.trim() &&
        !/^(```|!\[|#{1,3} |[-*] |\d+\. )/.test(lines[i]!) &&
        !tableHeader(lines, i)
      )
        para.push(lines[i++]!);
      blocks.push(<p key={i}>{inline(para.join("\n"))}</p>);
    }
  }
  return <div className="message-text">{blocks}</div>;
}
