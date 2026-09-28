import { useEffect, useState } from "react";
import { isRenderedFile, type RenderedFile } from "../shared/rendered-files";
import { GeneratedImages } from "./GeneratedImages";
import { api } from "./api";

function TextFile({ file }: { file: RenderedFile }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<{
    text: string;
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setError(false);
    setPreview(null);
    void api("/control-session")
      .then(() =>
        api<{ text: string; truncated: boolean }>(
          `${file.url.slice("/api".length)}?preview=1`,
        ),
      )
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [expanded, file.url, attempt]);
  return (
    <section className="rendered-file" aria-label={`File: ${file.name}`}>
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          {file.name}{" "}
          <small>Text file · {file.size.toLocaleString()} bytes</small>
        </summary>
        {error ? (
          <p role="alert">
            Could not load the file.{" "}
            <button onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          </p>
        ) : preview ? (
          <>
            <pre>{preview.text}</pre>
            {preview.truncated && (
              <p>
                Preview shortened. Download the file for its complete contents.
              </p>
            )}
          </>
        ) : (
          <p role="status">Loading preview…</p>
        )}
        <a href={file.url} download={file.name}>
          Download file
        </a>
      </details>
    </section>
  );
}
export function RenderedFiles({ files }: { files: unknown }) {
  if (!Array.isArray(files)) return null;
  return (
    <>
      {files
        .filter(isRenderedFile)
        .map((file) =>
          file.kind === "image" ? (
            <GeneratedImages
              key={file.url}
              images={[{ ...file, alt: file.name }]}
            />
          ) : (
            <TextFile key={file.url} file={file} />
          ),
        )}
    </>
  );
}
