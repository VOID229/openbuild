import "@fontsource-variable/inter";
import "@fontsource/comic-neue/400.css";
import "@fontsource/comic-neue/700.css";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CloudProvider, initCloud } from "./lib/cloud";

// iOS Safari only applies :active (the press effect on touch screens) when a touch listener exists.
document.addEventListener("touchstart", () => {}, { passive: true });

await initCloud();
createRoot(document.getElementById("root")!).render(
  <CloudProvider>
    <App />
  </CloudProvider>,
);
