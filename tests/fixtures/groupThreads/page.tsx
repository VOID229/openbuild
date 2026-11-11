// The whole app on a fake server, for tests/groupThreadsUi.test.ts (a group's Threads tab, bot chats' thread
// links, a thread's pull request badge) in Chrome.
// The fake server comes first, so everything the app asks for is answered by it (see fakeServer.ts).
import "./fakeServer";
import "@fontsource-variable/inter";
import "@fontsource/comic-neue/400.css";
import "@fontsource/comic-neue/700.css";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/geist-mono";
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { RELOAD_THREADS } from "../../../src/lib/pulls";
import { trackKeyboardNav } from "../../../src/lib/keyboardNav";

const { App, preloadApp } = await import("../../../src/App");
const { useStore } = await import("../../../src/lib/store");
const { useBots } = await import("../../../src/lib/bots/store");
const { usePanel } = await import("../../../src/lib/panel");
await preloadApp();
useStore.getState().updateSettings({ theme: new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark" });
Object.assign(window, { store: useStore, bots: useBots, panel: usePanel, reloadThreads: () => window.dispatchEvent(new Event(RELOAD_THREADS)) });
// As main.tsx does, so focus rings show once the keyboard is in use.
trackKeyboardNav();
createRoot(document.getElementById("root")!).render(<App />);
