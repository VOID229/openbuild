import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Attachment } from "../../shared/types";
import { usePresence } from "../lib/ui";
import { IconButton } from "./primitives";

type Image = Pick<Attachment, "id" | "name" | "dataUrl">;

interface LightboxState {
  open: boolean;
  images: Image[];
  index: number;
}

// The images stay put after closing so they're still there during the exit transition.
export const useLightbox = create<LightboxState>(() => ({ open: false, images: [], index: 0 }));

/**
 * What the preview grows out of and shrinks back into: the thumbnail that was clicked, found from the
 * last press (Safari doesn't focus a clicked button, so the focused element alone isn't enough).
 */
let lastPress: Element | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => { lastPress = e.target as Element; }, { capture: true, passive: true });
}
let origin: { el: Element; index: number } | undefined;

export function openLightbox(images: Image[], id: string) {
  const index = images.findIndex((i) => i.id === id);
  if (index < 0) return;
  const pressed = lastPress?.closest("button") ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
  origin = pressed ? { el: pressed.querySelector("img") ?? pressed, index } : undefined;
  useLightbox.setState({ open: true, images, index });
}

const ZOOM_IN_MS = 280;
const ZOOM_OUT_MS = 220;
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The thumbnail's box, if it's still on screen to animate to or from. */
function originRect(index: number): DOMRect | undefined {
  if (!origin || origin.index !== index || !origin.el.isConnected) return undefined;
  const r = origin.el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return undefined;
  return r;
}

/** The transform that puts the full-size image `to` exactly over the thumbnail `from`. */
function over(from: DOMRect, to: DOMRect) {
  const scale = Math.min(from.width / to.width, from.height / to.height);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

const close = () => useLightbox.setState({ open: false });
const step = (by: number) => useLightbox.setState((s) => ({ index: Math.max(0, Math.min(s.images.length - 1, s.index + by)) }));

/**
 * Full-screen image preview. Every image is mounted at once and stacked, so switching only
 * cross-fades already-decoded layers instead of swapping a `src` (which would flash).
 */
export function Lightbox() {
  const { open, images, index } = useLightbox();
  const { mounted, visible } = usePresence(open, ZOOM_OUT_MS);
  const root = useRef<HTMLDivElement>(null);
  // Zooming from (and back to) the thumbnail replaces the stage's own fade.
  const [zoom, setZoom] = useState(false);

  // Open: the image grows out of the thumbnail it was clicked from.
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    if (reducedMotion()) { setZoom(false); return; }
    const img = root.current?.querySelector<HTMLImageElement>('.lightbox-slide[data-pos="current"] .lightbox-image');
    const from = originRect(useLightbox.getState().index);
    if (!img || !from || !img.naturalWidth) { setZoom(false); return; }
    const to = img.getBoundingClientRect();
    if (!to.width || !to.height) return;
    setZoom(true);
    img.animate([{ transform: over(from, to), borderRadius: "12px" }, { transform: "none" }], { duration: ZOOM_IN_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }, [open, mounted]);

  // Close: back into the thumbnail, if the image shown is still the one that was clicked.
  useLayoutEffect(() => {
    if (open || !mounted) return;
    const img = root.current?.querySelector<HTMLImageElement>('.lightbox-slide[data-pos="current"] .lightbox-image');
    const to = originRect(useLightbox.getState().index);
    if (!img || !to || reducedMotion()) { setZoom(false); return; }
    setZoom(true);
    img.animate([{ transform: "none" }, { transform: over(to, img.getBoundingClientRect()) }], { duration: ZOOM_OUT_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" });
  }, [open, mounted]);
  const swipe = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    const restoreFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else return;
      // Captured first so nothing underneath (popovers, the composer) also reacts.
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      restoreFocus?.focus?.({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (open && mounted) root.current?.focus({ preventScroll: true });
  }, [open, mounted]);

  if (!mounted) return null;
  const current = images[index];
  const many = images.length > 1;
  return (
    <div
      ref={root}
      className="lightbox"
      data-state={visible ? "open" : "closed"}
      data-zoom={zoom || undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      tabIndex={-1}
      onPointerDown={(e) => {
        swipe.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const s = swipe.current;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) s.moved = true;
      }}
      onPointerUp={(e) => {
        const s = swipe.current;
        if (!s || e.pointerType === "mouse") return;
        const dx = e.clientX - s.x;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(e.clientY - s.y)) step(dx < 0 ? 1 : -1);
      }}
      onClick={(e) => {
        // Clicking anywhere but the image (or a control) dismisses; a swipe doesn't.
        if (swipe.current?.moved) return;
        if ((e.target as HTMLElement).closest(".lightbox-image, button")) return;
        close();
      }}
    >
      <div className="lightbox-backdrop" aria-hidden />
      <div className="lightbox-stage">
        {images.map((img, i) => (
          <div key={img.id} className="lightbox-slide" data-pos={i < index ? "before" : i > index ? "after" : "current"} aria-hidden={i !== index}>
            <img className="lightbox-image" src={img.dataUrl} alt={img.name} draggable={false} />
          </div>
        ))}
      </div>
      {many && (
        <>
          <IconButton label="Previous image" tooltip={false} className="lightbox-nav lightbox-prev" disabled={index === 0} onClick={() => step(-1)}>
            <ChevronLeft size={22} />
          </IconButton>
          <IconButton label="Next image" tooltip={false} className="lightbox-nav lightbox-next" disabled={index === images.length - 1} onClick={() => step(1)}>
            <ChevronRight size={22} />
          </IconButton>
        </>
      )}
      <IconButton label="Close preview" tooltip={false} className="lightbox-close" onClick={close}>
        <X size={20} />
      </IconButton>
      <div className="lightbox-caption">
        <span className="lightbox-name">{current?.name}</span>
        {many && (
          <span className="lightbox-count">
            {index + 1} / {images.length}
          </span>
        )}
      </div>
    </div>
  );
}
