// Settings → Bots' machine list and Settings → Devices, inside the Settings page's own frame, for
// tests/botMachinesChrome.test.ts to click through in Chrome. The server is faked here: the machines
// a bot reaches, the paired devices, and the isolation saves, which are kept in `window.saved`.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import type { ComputerTarget } from "../../../shared/bots";
import { BotMachines } from "../../../src/components/bots/BotAdvanced";
import { DevicesSection } from "../../../src/components/DeviceSettings";
import { enterWorkspace } from "../../../src/lib/bots/store";
import { useWorkspace } from "../../../src/lib/bots/workspace";
import { useStore } from "../../../src/lib/store";

const params = new URLSearchParams(location.search);
const all = { files: true, terminal: true, browser: true, unisolated: true };
const none = { files: false, terminal: false, browser: false, unisolated: false };
const targets: ComputerTarget[] = [
  // What the server reports with nothing chosen: the host where it's allowed, a container where it isn't.
  { device: "local", name: "Studio iMac", status: "ready", grants: all, engines: ["podman"], isolation: "host" },
  { device: "mbp", name: "MacBook Pro of someone with a long machine name", status: "access", grants: none, isolation: "container" },
  { device: "vm", name: "Cloud VM", status: "ready", grants: { files: true, terminal: true, browser: false, unisolated: false }, isolation: "container" },
  { device: "old", name: "Old Mini", status: "offline", message: "Old Mini is unreachable", isolation: "container" },
];
// Enough paired devices that the one linked to starts out of view.
const filler = Array.from({ length: 6 }, (_, i) => ({ id: `spare${i}`, name: `Spare ${i + 1}`, mode: "lan", urls: [`http://spare${i}`], status: "online", online: true }));
const devices = [
  { id: "srv", name: "Studio iMac", local: true, mode: "lan", urls: [], online: true },
  ...filler,
  { id: "mbp", name: "MacBook Pro of someone with a long machine name", mode: "tailscale", urls: ["http://mbp.tail.ts.net:8787"], status: "online", online: true },
  { id: "vm", name: "Cloud VM", mode: "lan", urls: ["http://10.0.0.7:8787"], status: "online", online: true },
  { id: "old", name: "Old Mini", mode: "lan", urls: ["http://10.0.0.9:8787"], status: "offline", online: false },
];
(window as any).saved = [];
Object.assign(window, { store: useStore });
window.fetch = (async (input: string, init?: RequestInit) => {
  const path = String(input).replace(location.origin, "");
  const isolation = /^\/api\/bots\/targets\/([^/]+)$/.exec(path);
  if (isolation && init?.method === "PATCH") {
    const body = JSON.parse(String(init.body));
    (window as any).saved.push({ device: decodeURIComponent(isolation[1]!), ...body });
    const t = targets.find((x) => x.device === decodeURIComponent(isolation[1]!));
    if (t) t.isolation = body.isolation;
    return Response.json({ isolation: body.isolation });
  }
  if (path === "/api/bots/targets") return Response.json({ targets });
  if (path === "/api/devices") return Response.json({ devices });
  if (path === "/api/paired-clients") return Response.json({ clients: [] });
  return Response.json({});
}) as typeof fetch;
window.confirm = () => true;

useWorkspace.setState({ localId: "srv", localName: "Studio iMac" });
enterWorkspace("srv");
useStore.setState({ devices, devicesLoaded: true } as never);
useStore.getState().openSettings("bots");
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";

function Page() {
  const section = useStore((s) => s.settingsSection);
  const phone = matchMedia("(max-width: 768px)").matches;
  return (
    <div className="spage" role="region" aria-label="Settings">
      <div className="spage-body">
        {!phone && (
          <nav className="settings-nav" aria-label="Settings sections">
            {(["bots", "devices"] as const).map((id) => (
              <button key={id} type="button" className="settings-nav-item" aria-current={section === id} onClick={() => useStore.setState({ settingsSection: id, settingsPage: undefined })}>
                <span className="settings-nav-label">{id === "bots" ? "Bots" : "Devices"}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="settings-content">
          <div className="settings-inner" key={section}>
            {section === "devices" ? (
              <DevicesSection />
            ) : (
              <section className="bots-set-block">
                <label className="md-label bots-set-label">
                  <span className="md-hash">#</span>Machines
                </label>
                <BotMachines />
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Page />);
