import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { MoveHorizontal } from "lucide-react";

/** Enlarge the local viewer, never the remote desktop or website's zoom. */
export function ComputerViewport({ displayRef, connected, hidden, onPan, fillAvailable = false }: {
  displayRef: RefObject<HTMLDivElement | null>;
  connected: boolean;
  hidden: boolean;
  onPan: () => void;
  fillAvailable?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, availableHeight: 0, portrait: false, aspect: 0 });
  const [position, setPosition] = useState(0);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const display = displayRef.current!;
    const media = window.matchMedia("(max-width: 767px) and (orientation: portrait)");
    const measure = () => {
      // Connected desktops have arbitrary resolutions. Observe dimensions only,
      // not pixels; noVNC keeps its own scaling and pointer mapping authoritative.
      const canvas = display.querySelector("canvas");
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        availableHeight: element.parentElement!.clientHeight,
        portrait: media.matches,
        aspect: canvas?.width && canvas.height ? canvas.width / canvas.height : 0,
      };
      setSize(old => old.width === next.width && old.height === next.height && old.availableHeight === next.availableHeight &&
        old.portrait === next.portrait && old.aspect === next.aspect ? old : next);
    };
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    resize?.observe(element);
    resize?.observe(element.parentElement!);
    const canvasChanges = new MutationObserver(measure);
    canvasChanges.observe(display, { childList: true, subtree: true, attributes: true, attributeFilter: ["width", "height"] });
    media.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    if (!connected || hidden) setPosition(0);
    measure();
    return () => {
      resize?.disconnect();
      canvasChanges.disconnect();
      media.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
    };
  }, [displayRef, connected, hidden]);
  // Reserve the compact 44px pan row + 4px gap when deciding if it is needed.
  // Measuring the whole flexible viewer avoids show/hide oscillation as the
  // phone keyboard changes available height near the pan threshold.
  const roomToPan = !fillAvailable || (size.availableHeight - 48) * size.aspect > size.width + 1;
  const width = connected && !hidden && size.portrait && size.aspect && roomToPan
    ? Math.max(size.width, size.height * size.aspect)
    : size.width;
  const overflow = Math.max(0, width - size.width);
  const panning = overflow > 1;
  return <div className="chrome-share-viewer" hidden={hidden}>
    {panning && <div className="chrome-share-pan">
      <MoveHorizontal size={20} aria-hidden="true" />
      <span>Pan</span>
      <input type="range" min="0" max="100" step="1" value={position}
        aria-label="Pan computer left and right"
        aria-valuetext={`${position}% from left`}
        onPointerDown={onPan}
        onFocus={onPan}
        onChange={event => setPosition(Number(event.target.value))} />
    </div>}
    <div className="chrome-share-screen" ref={viewport}>
      <div className="chrome-share-display" ref={displayRef} style={{
        width: panning ? `${width}px` : "100%",
        transform: panning ? `translateX(${-overflow * position / 100}px)` : undefined,
      }} />
    </div>
  </div>;
}
