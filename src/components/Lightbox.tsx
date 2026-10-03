import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef } from "react";
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

export function openLightbox(images: Image[], id: string) {
  const index = images.findIndex((i) => i.id === id);
  if (index >= 0) useLightbox.setState({ open: true, images, index });
}

const close = () => useLightbox.setState({ open: false });
const step = (by: number) => useLightbox.setState((s) => ({ index: Math.max(0, Math.min(s.images.length - 1, s.index + by)) }));

/**
 * Full-screen image preview. Every image is mounted at once and stacked, so switching only
 * cross-fades already-decoded layers instead of swapping a `src` (which would flash).
 */
export function Lightbox() {
  const { open, images, index } = useLightbox();
  const { mounted, visible } = usePresence(open, 220);
  const root = useRef<HTMLDivElement>(null);
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
