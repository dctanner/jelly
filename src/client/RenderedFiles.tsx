import { useEffect, useState } from "react";
import {
  isRenderedFile,
  isHtmlFile,
  type RenderedFile,
} from "../shared/rendered-files";
import { GeneratedImages } from "./GeneratedImages";
import { api } from "./api";

function HtmlFile({ file }: { file: RenderedFile }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setReady(false);
    setError(false);
    // Establish the private attachment cookie before the browser loads the frame.
    void api("/control-session")
      .then(() => {
        if (active) setReady(true);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [file.url, attempt]);
  return (
    <section
      className="rendered-file rendered-html"
      aria-label={`File: ${file.name}`}
    >
      <div className="rendered-html-heading">
        <span>{file.name}</span>
        <a href={file.url} download={file.name}>
          Download file
        </a>
      </div>
      {error ? (
        <p role="alert">
          Could not load the preview.{" "}
          <button onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </p>
      ) : ready ? (
        <iframe
          src={`${file.url}?inline=1`}
          title={`HTML preview: ${file.name}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      ) : (
        <p role="status">Loading preview…</p>
      )}
    </section>
  );
}

function MediaFile({ file }: { file: RenderedFile }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setReady(false);
    setError(false);
    void api("/control-session")
      .then(() => {
        if (active) setReady(true);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [file.url, attempt]);
  return (
    <section
      className="rendered-file rendered-media"
      aria-label={`File: ${file.name}`}
    >
      <div className="rendered-html-heading">
        <span>{file.name}</span>
        <a href={`${file.url}?download=1`} download={file.name}>
          Download file
        </a>
      </div>
      {error ? (
        <p role="alert">
          This file could not be played. Download it or{" "}
          <button onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
          .
        </p>
      ) : !ready ? (
        <p role="status">Loading player…</p>
      ) : file.kind === "video" ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={file.url}
          aria-label={`Video: ${file.name}`}
          onError={() => setError(true)}
        />
      ) : (
        <audio
          controls
          preload="metadata"
          src={file.url}
          aria-label={`Audio: ${file.name}`}
          onError={() => setError(true)}
        />
      )}
    </section>
  );
}

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
          ) : file.kind === "audio" || file.kind === "video" ? (
            <MediaFile key={file.url} file={file} />
          ) : isHtmlFile(file) ? (
            <HtmlFile key={file.url} file={file} />
          ) : (
            <TextFile key={file.url} file={file} />
          ),
        )}
    </>
  );
}
