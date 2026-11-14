// The side panel with browser tabs, for tests/browserPanel.test.ts to drive in Chrome. The test's
// fixture server answers /api/preview with a real preview (server/preview.ts) of its dev server.
import "../../../src/styles.css";
import { createRoot } from "react-dom/client";
import { SidePanel } from "../../../src/components/SidePanel";
import { usePanel } from "../../../src/lib/panel";
import type { TerminalFolder } from "../../../src/lib/terminal";

document.documentElement.dataset.theme = "dark";
const folder: TerminalFolder = { label: "Fixture", thread: "fixture-thread" };
usePanel.getState().showFolder(folder);
Object.assign(window, { panel: usePanel });
createRoot(document.getElementById("root")!).render(<SidePanel folder={folder} toolsWidth={0} />);
