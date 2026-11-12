// Bots on their own, for tests/botAvatarLife.test.ts to watch in Chrome: one in every mood, held
// still; a row of awake ones, idle and busy, big and small, living their lives; one of every shape
// that only follows the pointer; and a playful one to press.
import "../../../src/styles.css";
import "../../../src/bots.css";
import { createRoot } from "react-dom/client";
import { BotAvatar } from "../../../src/components/bots/BotAvatar";
import { SHAPES, type BotLook, type Mood } from "../../../src/lib/bots/looks";

const moods: Mood[] = ["idle", "happy", "thinking", "sleepy", "surprised", "love", "wink", "squint"];
const looks: BotLook[] = [{ shape: "blob", color: "green" }, { shape: "cloud", color: "white" }, { shape: "tablet", color: "pink" }];
createRoot(document.getElementById("root")!).render(
  <>
    <div className="row" id="moods">
      {moods.map((mood) => (
        <span className="cell" key={mood} data-mood={mood}>
          <BotAvatar look={looks[0]!} size={96} mood={mood} alive={false} />
        </span>
      ))}
    </div>
    <div className="row" id="life">
      {looks.flatMap((look) => [
        <span className="cell" key={`${look.shape}-idle`} data-size={96}><BotAvatar look={look} size={96} lively /></span>,
        <span className="cell" key={`${look.shape}-busy`} data-size={96}><BotAvatar look={look} size={96} lively busy /></span>,
        <span className="cell" key={`${look.shape}-small`} data-size={28}><BotAvatar look={look} size={28} /></span>,
        <span className="cell" key={`${look.shape}-small-busy`} data-size={28}><BotAvatar look={look} size={28} busy /></span>,
      ])}
    </div>
    <div className="row" id="shapes">
      {SHAPES.map((s) => (
        <span className="cell" key={s.id} data-shape={s.id}><BotAvatar look={{ shape: s.id, color: "blue" }} size={64} alive={false} track /></span>
      ))}
    </div>
    <div className="row" id="play">
      <span className="cell"><BotAvatar look={looks[1]!} size={96} alive={false} playful /></span>
    </div>
  </>,
);
