// The ⌘K cheatsheet on its own, for tests/cheatsheetUi.test.ts to look at in Chrome. It opens on load;
// `window.toggleCheatsheet` opens it again after it closes.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { Cheatsheet } from "../../../src/components/Cheatsheet";
import { toggleCheatsheet } from "../../../src/lib/cheatsheet";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
(window as any).toggleCheatsheet = toggleCheatsheet;
createRoot(document.getElementById("root")!).render(
  <>
    <button type="button" id="before" autoFocus>Before</button>
    <Cheatsheet />
  </>,
);
toggleCheatsheet();
