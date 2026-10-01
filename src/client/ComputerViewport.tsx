import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import "./ComputerViewport.css";

/** Enlarge only the viewer, not the remote desktop or the website's zoom. */
export function ComputerViewport({ displayRef, interactive, hidden, onPan }: {
  displayRef: RefObject<HTMLDivElement | null>;
  interactive: boolean;
  hidden: boolean;
  onPan: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, portrait: false });
  const [position, setPosition] = useState(0);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const media = window.matchMedia("(max-width: 767px) and (orientation: portrait)");
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight, portrait: media.matches });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    media.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer?.disconnect(); media.removeEventListener("change", measure); window.removeEventListener("resize", measure); };
  }, []);
  // The managed Xvfb desktop is fixed at 1280x800 (resizeSession is disabled).
  // Give noVNC a height-fitted target and clip it, so its own scaling and
  // pointer-coordinate conversion remain authoritative at every pan position.
  const width = interactive && size.portrait ? Math.max(size.width, size.height * 1280 / 800) : size.width;
  const overflow = Math.max(0, width - size.width);
  const panning = !hidden && overflow > 1;
  return <div className="computer-viewer" hidden={hidden}>
    {panning && <div className="computer-pan">
      <span aria-hidden="true">↔</span>
      <input type="range" min="0" max="100" step="1" value={position}
        aria-label="Pan browser left and right"
        aria-valuetext={`${position}% from left`}
        onPointerDown={onPan}
        onFocus={onPan}
        onChange={event => setPosition(Number(event.target.value))} />
    </div>}
    <div className="computer-screen" ref={viewport}>
      <div className="computer-display" ref={displayRef} style={{
        width: panning ? `${width}px` : "100%",
        transform: panning ? `translateX(${-overflow * position / 100}px)` : undefined,
      }} />
    </div>
  </div>;
}
