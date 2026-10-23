// A plugin's client module is an ordinary ES module. `react` and `openbuild` are provided by the
// host, so no build step or dependencies are needed here.
import { useState } from "react";
import { insertComposerText } from "openbuild";

function DailyNoteButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const insert = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/plugins/daily-note/today");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { text?: string };
      if (data.text) insertComposerText(data.text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="plugin-slot-button plugin-daily-note"
      title={error ? `Couldn't get a note: ${error}` : "Add today's note prompt"}
      onClick={() => void insert()}
      disabled={busy}
    >
      <span aria-hidden>✎</span>
      {busy ? "…" : "Note"}
    </button>
  );
}

function DailyNoteSettings() {
  return (
    <div className="plugin-daily-note-settings">
      <p>
        <strong>Daily note</strong> adds a <em>Note</em> button to the composer. It calls{" "}
        <code>/api/plugins/daily-note/today</code> on this OpenBuild server and inserts the prompt it gets back.
      </p>
      <p className="settings-hint">
        Edit <code>plugins/daily-note/client.tsx</code> or <code>server.ts</code> to change it. Client edits reload
        in open browsers; server edits need an OpenBuild restart.
      </p>
    </div>
  );
}

// The default export describes the plugin. Components registered in `slots` receive the slot's
// context as props (the composer passes { variant, chatId }).
export default {
  slots: {
    "composer:toolbar": DailyNoteButton,
  },
  settings: {
    label: "Daily note",
    component: DailyNoteSettings,
  },
};
