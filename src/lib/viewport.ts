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
  // The tallest the viewport has been: what it is with no keyboard in the way. Safari leaves
  // innerHeight alone when the keyboard opens (Chrome shrinks it), so the drop from this baseline
  // is the one sign of a keyboard that works in both.
  let tallest = vv.height;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      tallest = Math.max(tallest, vv.height);
      root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
      // A keyboard (not just a collapsing toolbar) is covering the bottom of the screen.
      root.toggleAttribute("data-keyboard", tallest - vv.height > 120);
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    });
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  window.addEventListener("scroll", update, { passive: true });
  // A turned screen is a different shape: measure it afresh instead of against the old one.
  window.addEventListener("orientationchange", () => {
    tallest = 0;
    setTimeout(update, 300);
    update();
  });
  // Closing the keyboard animates; settle once it's done.
  document.addEventListener("focusout", () => setTimeout(update, 300));
  update();
}
