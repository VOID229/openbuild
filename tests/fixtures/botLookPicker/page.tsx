// The look pickers, for tests/botLookPicker.test.ts to look at in Chrome: `?view=dialog` is the real
// New bot dialog, `?view=editor` the details panel's Look editor (its picker, as the panel lays it
// out), and `?view=gallery` every shape in every face a still bot pulls, at the picker's size.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BotAvatar } from "../../../src/components/bots/BotAvatar";
import { CreateBotDialog, LookPicker } from "../../../src/components/bots/BotDialogs";
import { SHAPES, type BotLook, type Mood } from "../../../src/lib/bots/looks";

const params = new URLSearchParams(location.search);
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;
const view = params.get("view") ?? "dialog";

function Editor() {
  const [look, setLook] = useState<BotLook>({ shape: "house", color: "purple" });
  return (
    <div style={{ position: "relative", width: 320, padding: 8 }}>
      <div className="bots-look-editor" style={{ position: "static" }}>
        <div className="bots-look-editor-head"><span>Look</span></div>
        <LookPicker look={look} onChange={setLook} />
      </div>
    </div>
  );
}

const moods: Mood[] = ["idle", "happy", "love", "thinking", "surprised", "sleepy", "wink"];
createRoot(document.getElementById("root")!).render(
  view === "editor" ? <Editor />
  : view === "gallery" ? (
    <div id="gallery">
      {moods.map((mood) => (
        <div className="row" key={mood} data-mood={mood}>
          {SHAPES.map((s) => (
            <span key={s.id} aria-label={s.label}>
              <BotAvatar look={{ shape: s.id, color: "purple" }} size={40} mood={mood} alive={false} />
            </span>
          ))}
        </div>
      ))}
    </div>
  )
  : <CreateBotDialog onClose={() => {}} />,
);
