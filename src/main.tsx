import "@fontsource-variable/inter";
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
