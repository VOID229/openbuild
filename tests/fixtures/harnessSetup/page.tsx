// The startup popup for a server without Pi, for tests/harnessSetupUi.test.ts to look at in Chrome.
// The fake server comes first, so the app's /api/config is answered by it (see fakeServer.ts).
import "./fakeServer";
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { HarnessSetup } from "../../../src/components/HarnessSetup";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(<HarnessSetup />);
