import { useEffect, useState } from "react";
import { api } from "./api";
import { isGeneratedImageUrl } from "../shared/generated-images";
import { isToolImageUrl } from "../shared/tool-images";
import { isRenderedFileUrl } from "../shared/rendered-files";

function ImageAttachment({
  image,
  ready,
  authError,
  retry,
}: {
  image: Record<string, any>;
  ready: boolean;
  authError: boolean;
  retry: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const knownSize =
    Number.isSafeInteger(image.width) &&
    image.width > 0 &&
    image.width <= 32768 &&
    Number.isSafeInteger(image.height) &&
    image.height > 0 &&
    image.height <= 32768;
  // Legacy attachments have no dimensions. Keep their square frame even after
  // decoding instead of replacing a tiny placeholder with a full-sized image.
  const ratio = knownSize ? image.width / image.height : 1;
  const error = authError || failed;
  return (
    <figure>
      <div
        className="image-frame"
        style={{
          aspectRatio: String(ratio),
          maxWidth: Math.min(640, 640 * ratio),
        }}
      >
        {error ? (
          <p className="image-state" role="alert">
            Could not load the image.{" "}
            <button
              onClick={() => {
                setFailed(false);
                retry();
              }}
            >
              Retry
            </button>
          </p>
        ) : !ready ? (
          <p className="image-state" role="status">
            Loading image…
          </p>
        ) : (
          <a
            href={image.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={
              isGeneratedImageUrl(image.url)
                ? "Open generated image"
                : "Open image attachment"
            }
          >
            <img
              src={image.url}
              alt={typeof image.alt === "string" ? image.alt : "Image"}
              loading="lazy"
              decoding="async"
              onError={() => setFailed(true)}
            />
          </a>
        )}
      </div>
      <figcaption>
        <a
          href={ready ? image.url : undefined}
          aria-disabled={!ready || undefined}
          download={
            typeof image.name === "string"
              ? image.name
              : isGeneratedImageUrl(image.url)
                ? "generated-image.png"
                : `image.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/gif" ? "gif" : image.mimeType === "image/webp" ? "webp" : image.mimeType === "image/bmp" ? "bmp" : "png"}`
          }
        >
          Download image
        </a>
      </figcaption>
    </figure>
  );
}

export function GeneratedImages({ images }: { images: unknown }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
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
  }, [attempt]);
  const items = Array.isArray(images)
    ? images
        .filter(
          (image) =>
            image &&
            typeof image === "object" &&
            (isGeneratedImageUrl(image.url) ||
              isToolImageUrl(image.url) ||
              isRenderedFileUrl(image.url)),
        )
        .slice(0, 4)
    : [];
  if (!items.length) return null;
  return (
    <div
      className="generated-images"
      aria-label={
        items.every((image) => isGeneratedImageUrl(image.url))
          ? "Generated images"
          : "Image attachments"
      }
    >
      {items.map((image) => (
        <ImageAttachment
          key={image.url}
          image={image}
          ready={ready}
          authError={error}
          retry={() => {
            setReady(false);
            setAttempt((a) => a + 1);
          }}
        />
      ))}
    </div>
  );
}
