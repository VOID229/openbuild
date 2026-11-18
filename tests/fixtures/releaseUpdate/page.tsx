// The whole app on a fake server whose releases the test controls (./fakeServer.ts), for
// tests/releaseUpdate.test.ts: the update button beside the version in either sidebar's footer; and
// for tests/updateNotices.test.ts, the harness update notices over the window.
import "./fakeServer";
import "@fontsource-variable/geist";
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";

const { App, preloadApp } = await import("../../../src/App");
const { useStore } = await import("../../../src/lib/store");
const { useReleaseUpdate } = await import("../../../src/lib/releaseUpdate");
await preloadApp();
Object.assign(window, { store: useStore, update: useReleaseUpdate });
createRoot(document.getElementById("root")!).render(<App />);
