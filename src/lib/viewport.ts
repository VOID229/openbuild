/**
 * Pins the app to the visible screen on iOS Safari and home-screen web apps.
 *
 * The on-screen keyboard doesn't resize the layout viewport there; it scrolls the whole page up
 * instead, which pushes the fixed top bar (sidebar / new chat buttons) off screen, and the page
 * doesn't always scroll back after the keyboard closes. So the app is sized to the visual
 * viewport (the part above the keyboard) and the page is kept scrolled to the top.
 */
export function lockViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
      // A keyboard (not just a collapsing toolbar) is covering the bottom of the screen.
      root.toggleAttribute("data-keyboard", window.innerHeight - vv.height > 120);
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    });
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("orientationchange", update);
  // Closing the keyboard animates; settle once it's done.
  document.addEventListener("focusout", () => setTimeout(update, 300));
  update();
}
