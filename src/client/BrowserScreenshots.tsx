import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Activity } from "../shared/types";
import { toolImages } from "../shared/tool-images";
import { GeneratedImages } from "./GeneratedImages";
import "./BrowserScreenshots.css";

/** One visible attachment, with the live end selected until the reader browses back. */
export function BrowserScreenshots({ events }: { events: Activity[] }) {
  const images = events.flatMap(toolImages);
  const [selected, setSelected] = useState<string | null>(null);
  const id = useId();
  if (!images.length) return null;
  const found = selected === null ? -1 : images.findIndex(image => image.url === selected);
  const index = found < 0 ? images.length - 1 : found;
  const latest = index === images.length - 1;
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(images.length - 1, index + delta));
    setSelected(next === images.length - 1 ? null : images[next]!.url);
  };
  return (
    <section className="browser-screenshots" aria-label="Browser screenshots" aria-roledescription="carousel">
      <div className="browser-screenshots-toolbar">
        <span>Browser screenshots</span>
        <div className="browser-screenshots-controls">
          <button type="button" aria-label="Previous screenshot" aria-controls={id}
            disabled={index === 0} onClick={() => move(-1)}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <span role="status" aria-live="polite" aria-atomic="true">{index + 1} / {images.length}</span>
          <button type="button" aria-label="Next screenshot" aria-controls={id}
            disabled={latest} onClick={() => move(1)}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <button type="button" disabled={latest} onClick={() => setSelected(null)}>Latest</button>
        </div>
      </div>
      <div id={id} role="group" aria-roledescription="slide" aria-label={`Screenshot ${index + 1} of ${images.length}`}>
        <GeneratedImages images={[images[index]!]} />
      </div>
    </section>
  );
}
