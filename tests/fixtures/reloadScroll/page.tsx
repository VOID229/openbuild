// The whole app on a fake server, for tests/reloadScroll.test.ts to scroll and reload in Chrome.
// The fake server comes first, so everything the app asks for is answered by it.
import "./fakeServer";
import "@fontsource-variable/geist";
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";

const { App, preloadApp } = await import("../../../src/App");
const { useStore } = await import("../../../src/lib/store");
await preloadApp();
Object.assign(window, { store: useStore });
createRoot(document.getElementById("root")!).render(<App />);
