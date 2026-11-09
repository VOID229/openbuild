// Settings → Bots → Friends: other people's OpenBuilds this one shares group chats with, whether
// they're connected, and removing one. Adding friends and sharing chats is `openbuild friend` in a
// terminal for now. Always this server's own friends, whichever workspace the tab is showing.
import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { MODE_LABEL, type FriendSummary } from "../../../shared/friends";
import { useBots } from "../../lib/bots/store";
import { ago, cx } from "../../lib/ui";
import { Spinner } from "../primitives";

const STATUS: Record<FriendSummary["status"], { label: string; dot?: string }> = {
  online: { label: "Connected" },
  offline: { label: "Not connected", dot: "pi-status-dot-off" },
  refused: { label: "Refused", dot: "pi-status-dot-bad" },
};

async function answer<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
  return body as T;
}

function FriendRow({ friend, onRemoved }: { friend: FriendSummary; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { label, dot } = STATUS[friend.status];
  const seen = friend.status !== "online" && friend.lastSeenAt ? ago(friend.lastSeenAt) : undefined;
  const remove = async () => {
    if (!confirm(`Stop being friends with ${friend.name}? Your shared chats stop syncing at once, and their OpenBuild can't connect here anymore.`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await answer(await fetch(`/api/friends/${encodeURIComponent(friend.id)}`, { method: "DELETE" }));
      onRemoved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <li className="pi-row device-row">
      <span className={cx("pi-status-dot", dot)} aria-hidden />
      <div className="pi-row-text">
        <span className="pi-row-name">
          {friend.name}
          <span className="device-status">{label}</span>
        </span>
        <span className="pi-row-desc" title={friend.status === "refused" ? "Their OpenBuild turned this one away: they may have removed you." : undefined}>
          {[friend.fingerprint, MODE_LABEL[friend.mode] ?? "LAN", friend.role === "host" ? "you connect to them" : "they connect here", friend.allowTools && "bots may use tools", seen && `seen ${seen}`].filter(Boolean).join(" · ")}
        </span>
        {friend.failing && (
          <span className="pi-error device-error" role="status">
            <CircleAlert size={13} /> A message from {friend.name} couldn't be delivered here ({friend.failing.error}). Still trying; what they send next waits for it.
          </span>
        )}
        {error && (
          <span className="pi-error device-error" role="alert">
            <CircleAlert size={13} /> {error}
          </span>
        )}
      </div>
      <span className="pi-row-actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={remove}>
          {busy ? <Spinner size={14} /> : "Remove"}
        </button>
      </span>
    </li>
  );
}

export function BotFriends() {
  const [friends, setFriends] = useState<FriendSummary[]>();
  const [error, setError] = useState<string>();
  // The live list changing (someone connected, or was added) is the cue to ask again.
  const live = useBots((s) => s.friends);
  const load = useCallback(
    () =>
      void fetch("/api/friends")
        .then((res) => answer<{ friends: FriendSummary[] }>(res))
        .then((body) => (setFriends(body.friends), setError(undefined)), (err: Error) => setError(err.message)),
    [],
  );
  useEffect(load, [load, live]);
  return (
    <>
      <div className="pi-subhead">
        <h3>Friends</h3>
      </div>
      <p className="setting-desc">
        Other people's OpenBuilds your bots share group chats with. A friend reaches those chats and nothing else here, and what they write is never taken as coming from you. Add one with{" "}
        <code>openbuild friend invite</code> on one computer and <code>openbuild friend add</code> on the other.
      </p>
      {error && (
        <p className="pi-error" role="alert">
          <CircleAlert size={13} /> {error}
        </p>
      )}
      <ul className="pi-list">
        {friends?.map((f) => <FriendRow key={f.id} friend={f} onRemoved={load} />)}
        {friends && !friends.length && <li className="pi-empty">No friends yet.</li>}
      </ul>
    </>
  );
}
