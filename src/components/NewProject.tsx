// New projects, from the project picker's "New project…": first where (a device, or a git URL to
// clone), then the New project dialog. A project is a folder on one of your devices: an existing
// one, a new one made under the default location (Settings → Projects), or a fresh clone. On the
// device this browser runs on, Browse opens the system's own folder picker.
import { ArrowLeft, Check, ChevronDown, GitBranch, Laptop, Monitor, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addProject, browseFolders, cloneProject, folderPickerAvailable, pickFolder } from "../lib/pi";
import { useStore } from "../lib/store";
import { splitProjectId } from "../lib/devices";
import { machineName } from "../lib/runtime";
import { arrowNav, cx, useFocusOnShow, usePresence } from "../lib/ui";
import { PathField } from "./PathField";
import { Popover } from "./primitives";

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
/** The default location, as a folder path ending in "/". */
export const projectsDir = (dir: string | undefined) => (dir?.trim() || "~").replace(/\/*$/, "/");
/** The folder a clone of `url` gets: the repository's name. */
const repoName = (url: string) =>
  url
    .trim()
    .replace(/[/\s]+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop() ?? "";

/** Where a new project comes from: a device (no id = this server), or a repository to clone onto one. */
export interface NewProjectStart {
  deviceId?: string;
  clone?: boolean;
}

/** The picker's second step: which device the project is on, or a git URL to clone. */
export function NewProjectSource({ onPick, onBack }: { onPick: (start: NewProjectStart) => void; onBack: () => void }) {
  const devices = useStore((s) => s.devices);
  const pref = useStore((s) => s.settings.workspace);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useFocusOnShow(search);
  const current = pref.projectId ? splitProjectId(pref.projectId).deviceId : pref.deviceId;
  // Clones go to the paired device new threads are on, when it's online; the dialog can change it.
  const cloneOn = devices.find((d) => !d.local && d.id === current && d.online !== false)?.id;
  const options = useMemo(() => {
    // Without a device list yet, this device still works.
    const list = devices.length ? devices : [undefined];
    return [
      ...list.map((d) => ({
        key: d?.id ?? "local",
        icon: !d || d.local ? Laptop : Monitor,
        name: d && !d.local ? d.name : "This device",
        sub: !d ? (machineName() ?? "This server") : d.local ? d.name : d.online === false ? "Offline" : (d.machine ?? "Paired device"),
        online: d ? d.online !== false : undefined,
        terms: d?.local || !d ? `this device ${d?.name ?? ""}` : d.name,
        start: { deviceId: d && !d.local ? d.id : undefined },
      })),
      { key: "git", icon: GitBranch, name: "Git URL", sub: "Clone a repository", online: undefined, terms: "git url clone repository", start: { clone: true, deviceId: cloneOn } },
    ];
  }, [devices, cloneOn]);
  const q = query.trim().toLowerCase();
  const shown = options.filter((o) => !q || o.terms.toLowerCase().includes(q));
  return (
    <>
      <label className="pp-search">
        <Search size={15} />
        <input
          ref={search}
          value={query}
          placeholder="Search devices…"
          aria-label="Search devices"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const first = shown.find((o) => o.online !== false);
            if (e.key === "Enter" && first) onPick(first.start);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              (e.currentTarget.closest(".pp")?.querySelector(".pp-pick:not(:disabled)") as HTMLElement | null)?.focus();
            }
          }}
        />
      </label>
      <div className="pp-list" onKeyDown={(e) => arrowNav(e)}>
        {shown.map((o) => (
          <div key={o.key} className="pp-row">
            <button type="button" className="pp-pick pp-pick-icon" disabled={o.online === false} onClick={() => onPick(o.start)}>
              <o.icon size={16} className="pp-icon" />
              <span className="pp-pick-text">
                <span className="pp-name">{o.name}</span>
                <span className="pp-sub">{o.sub}</span>
              </span>
              {o.online !== undefined && <span className={cx("pi-status-dot", !o.online && "pi-status-dot-off")} aria-label={o.online ? "Online" : "Offline"} />}
            </button>
          </div>
        ))}
        {!shown.length && <p className="pp-empty">No device matches “{query.trim()}”.</p>}
      </div>
      <div className="pp-foot">
        <button type="button" className="pp-action" onClick={onBack}>
          <ArrowLeft size={15} /> Projects
        </button>
      </div>
    </>
  );
}

export function NewProjectDialog({ start, onClose }: { start?: NewProjectStart; onClose: () => void }) {
  const { mounted, visible } = usePresence(!!start, 220);
  // Keep the last start through the closing transition.
  const last = useRef(start);
  if (start) last.current = start;
  if (!mounted || !last.current) return null;
  return <NewProject start={last.current} visible={visible} onClose={onClose} />;
}

function NewProject({ start, visible, onClose }: { start: NewProjectStart; visible: boolean; onClose: () => void }) {
  const devices = useStore((s) => s.devices);
  const pref = useStore((s) => s.settings.workspace);
  const base = projectsDir(useStore((s) => s.settings.projectsDir));
  const loadProjects = useStore((s) => s.loadProjects);
  const updateSettings = useStore((s) => s.updateSettings);
  const clone = !!start.clone;
  const [deviceId, setDeviceId] = useState(start.deviceId);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [path, setPath] = useState(base);
  const [exists, setExists] = useState<boolean>();
  const [canBrowse, setCanBrowse] = useState(false);
  const [busy, setBusy] = useState<"browse" | "add">();
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState(false);
  const deviceAnchor = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const device = devices.find((d) => (deviceId ? d.id === deviceId : d.local));
  const local = !deviceId;

  useEffect(() => {
    let live = true;
    if (local) void folderPickerAvailable().then((ok) => live && setCanBrowse(ok));
    else setCanBrowse(false);
    return () => {
      live = false;
    };
  }, [local]);

  // Whether the folder is already there (then it's added as it is) or will be made.
  // The folder. A clone left at the default location goes in a folder named after the repository there.
  const atBase = projectsDir(path) === base;
  const target = clone && atBase && repoName(url) ? base + repoName(url) : path.trim();
  useEffect(() => {
    setExists(undefined);
    if (!target) return;
    let live = true;
    const t = setTimeout(() => {
      browseFolders(target, deviceId).then(
        () => live && setExists(true),
        () => live && setExists(false),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [target, deviceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const browse = async () => {
    setBusy("browse");
    setError(undefined);
    try {
      const picked = await pickFolder(target || base);
      if (!picked) return;
      setPath(tilde(picked));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  // A new project needs a name with something visible in it (not only spaces or invisible characters).
  const named = /[\p{L}\p{N}\p{P}\p{S}]/u.test(name);
  const ready = !!target && (clone ? !!url.trim() && exists !== true : named) && !busy;
  const add = async () => {
    if (!ready) return;
    setBusy("add");
    setError(undefined);
    try {
      const p = clone ? await cloneProject(url.trim(), target, deviceId) : await addProject(target, deviceId, { name: name.trim() || undefined, create: true });
      await loadProjects();
      // New threads start in the new project.
      updateSettings({ workspace: { ...pref, projectId: deviceId ? `${deviceId}::${p.id}` : p.id, branch: undefined } });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(undefined);
    }
  };

  const others = devices.filter((d) => d !== device);
  const where = device ? (device.local ? "This device" : device.name) : (machineName() ?? "This device");
  return (
    <div className="modal-root" data-state={visible ? "open" : "closed"}>
      <div className="modal-backdrop" onClick={() => !busy && onClose()} aria-hidden />
      <div ref={dialog} className="modal np" role="dialog" aria-modal="true" aria-labelledby="np-title">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <h2 id="np-title" className="np-title">
            {clone ? "Clone repository" : "New project"}
          </h2>
          <p className="np-where">
            on{" "}
            {others.length ? (
              <button ref={deviceAnchor} type="button" className={cx("np-device", menu && "np-device-open")} aria-haspopup="listbox" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                {where}
                <ChevronDown size={12} className="pill-chevron" />
              </button>
            ) : (
              where
            )}
          </p>
          {clone ? (
            <input
              className="input np-url"
              autoFocus
              value={url}
              placeholder="https://github.com/owner/repo.git"
              aria-label="Git URL"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => {
                setUrl(e.target.value);
              }}
            />
          ) : (
            <div className={cx("np-row", canBrowse && "np-row-browse")}>
              <input
                className="input"
                autoFocus
                value={name}
                placeholder="Project name"
                aria-label="Project name"
                spellCheck={false}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
              {canBrowse && (
                <button type="button" className="btn btn-primary np-browse" disabled={!!busy} onClick={() => void browse()}>
                  {busy === "browse" ? "Choosing…" : "Browse"}
                </button>
              )}
            </div>
          )}
          <PathField
            className="np-path"
            value={path}
            label="Folder"
            deviceId={deviceId}
            onChange={setPath}
            // No point suggesting folders while a clone is being added over this path.
            disabled={busy === "add"}
          />
          <p className={cx("np-hint", error && "np-error")} role={error ? "alert" : undefined}>
            {error ??
              (clone
                ? busy === "add"
                  ? "Cloning… a big repository takes a while."
                  : url.trim() && exists
                    ? `${projectsDir(target).slice(0, -1)} already exists`
                    : ready
                      ? `Clones into ${projectsDir(target).slice(0, -1)}`
                      : " "
                : target && exists === false
                  ? `Creates ${projectsDir(target).slice(0, -1)}`
                  : target && exists
                    ? "Adds this folder as it is"
                    : " ")}
          </p>
          <div className="np-actions">
            <button type="button" className="btn np-cancel" onClick={onClose} disabled={busy === "add"}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!ready}>
              {busy === "add" ? (clone ? "Cloning…" : "Adding…") : clone ? "Clone" : "Add project"}
            </button>
          </div>
        </form>
      </div>
      <Popover open={menu} onClose={() => setMenu(false)} anchor={deviceAnchor} className="menu ws-menu" role="listbox" label="Device" fixed="auto">
        <div onKeyDown={(e) => arrowNav(e)}>
          {devices.map((d) => (
            <button
              key={d.id}
              type="button"
              role="option"
              aria-selected={d === device}
              className="menu-item"
              disabled={d.online === false}
              onClick={() => {
                setDeviceId(d.local ? undefined : d.id);
                setMenu(false);
              }}
            >
              <span className="menu-item-label">{d.local ? `${d.name} (this device)` : d.online === false ? `${d.name} (offline)` : d.name}</span>
              {d === device && <Check size={15} className="menu-check" />}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
