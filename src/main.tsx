import "@fontsource-variable/inter";
import "@fontsource/comic-neue/400.css";
import "@fontsource/comic-neue/700.css";
import "@fontsource-variable/exo-2";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/fredoka";
import "@fontsource-variable/jetbrains-mono";
import "katex/dist/katex.min.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CloudProvider, initCloud } from "./lib/cloud";

await initCloud();
createRoot(document.getElementById("root")!).render(
  <CloudProvider>
    <App />
  </CloudProvider>,
);
