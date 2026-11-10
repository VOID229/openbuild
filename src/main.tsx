import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/geist-mono";
import "@fontsource/comic-neue/400.css";
import "@fontsource/comic-neue/700.css";
import "@fontsource-variable/newsreader";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./bots.css";
import "./mobile.css";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LocalAccess } from "./components/LocalAccess";
import { trackKeyboardNav } from "./lib/keyboardNav";
import { lockViewport } from "./lib/viewport";

// iOS Safari only applies :active (the press effect on touch screens) when a touch listener exists.
document.addEventListener("touchstart", () => {}, { passive: true });
lockViewport();
trackKeyboardNav();

// Importing App starts config/state hydration. Delay even those imports until unlocked.
let application: Promise<import("react").ReactNode> | undefined;
const load = () => application ??= (async () => {
  const [{ App, preloadApp }, { CloudProvider, initCloud }] = await Promise.all([import("./App"), import("./lib/cloud")]);
  await Promise.all([initCloud(), preloadApp()]);
  return <CloudProvider><App /></CloudProvider>;
})();
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <LocalAccess load={load} />
  </ErrorBoundary>,
);
