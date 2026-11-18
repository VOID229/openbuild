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
const { noticeTiming } = await import("../../../src/components/Notices");
// `?noticeMs=` shortens how long a notice stays, so tests/updateNotices.test.ts needn't wait 4 s a time.
const noticeMs = Number(new URLSearchParams(location.search).get("noticeMs"));
if (noticeMs > 0) noticeTiming.ms = noticeMs;
await preloadApp();
Object.assign(window, { store: useStore, update: useReleaseUpdate });
createRoot(document.getElementById("root")!).render(<App />);
