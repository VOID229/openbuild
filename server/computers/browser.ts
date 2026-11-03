// A bot's browser: one headless Chromium per computer, with a profile in the bot's home folder so
// sign-ins stay between uses. Bots read pages as text with numbered refs ([12] button "Send"),
// then click and type by ref; screenshots are for when the layout matters. It closes after a while
// unused and opens again on the next call.
import type { Subprocess } from "bun";
import { Cdp, CdpError } from "./cdp";

const IDLE = 15 * 60_000;
const SNAPSHOT_MAX = 14_000;
export const VIEWPORT = { width: 1280, height: 900 };

/** Flags for every bot browser. `profile` and `downloads` are paths as the browser sees them. */
export function browserFlags(profile: string) {
  return [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--password-store=basic",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "about:blank",
  ];
}

/** `sh -c` that runs the browser with fd 3/4 on our stdin/stdout (the pipe protocol), its own stdout discarded. */
export const PIPE_SCRIPT = 'exec "$@" 3<&0 4>&1 1>/dev/null';

interface Tab {
  targetId: string;
  sessionId?: string;
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  Space: { code: "Space", keyCode: 32, text: " " },
};
const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// Runs in the page. Walks the visible DOM in order and writes it as lines: headings, text, and
// interactive elements tagged with a ref the other actions take. Refs stay on the elements
// (data-ob-ref), so they're stable until the page changes them.
const SNAPSHOT_JS = (max: number) => `(() => {
  const MAX = ${max};
  let n = window.__obRef || 0;
  const lines = [];
  let size = 0, cut = false, line = "";
  const push = (s) => { if (cut) return; if (size + s.length > MAX) { cut = true; return; } lines.push(s); size += s.length + 1; };
  const flush = () => { const t = line.replace(/\\s+/g, " ").trim(); if (t) push(t); line = ""; };
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","SVG","CANVAS","HEAD","META","LINK"]);
  const BLOCK = /^(DIV|P|LI|UL|OL|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|NAV|MAIN|ASIDE|FORM|FIELDSET|H[1-6]|BR|HR|DL|DT|DD|PRE|BLOCKQUOTE|FIGURE|FIGCAPTION|TD|TH)$/;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || s.display === "contents";
  };
  const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.getAttribute("alt") || el.getAttribute("placeholder") || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const ref = (el) => { let r = el.getAttribute("data-ob-ref"); if (!r) { r = String(++n); el.setAttribute("data-ob-ref", r); } return r; };
  const interactive = (el) => {
    const tag = el.tagName, role = el.getAttribute("role");
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") { const t = (el.type || "text").toLowerCase(); if (t === "hidden") return null; if (["button","submit","reset","image"].includes(t)) return "button"; if (t === "checkbox" || t === "radio") return t; return "textbox"; }
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    if (role && /^(button|link|checkbox|radio|tab|menuitem|option|switch|textbox|combobox|searchbox)$/.test(role)) return role;
    if (el.hasAttribute("onclick")) return "button";
    return null;
  };
  const describe = (el, kind) => {
    let s = "[" + ref(el) + "] " + kind;
    const label = el.labels && el.labels[0] ? el.labels[0].innerText.trim() : "";
    const nm = kind === "textbox" ? (label || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "") : name(el);
    if (nm) s += ' "' + nm.slice(0, 120) + '"';
    if (kind === "textbox" && el.value) s += " value=" + ((el.type || "").toLowerCase() === "password" ? "[redacted]" : JSON.stringify(String(el.value).slice(0, 80)));
    if ((kind === "checkbox" || kind === "radio") && el.checked) s += " (checked)";
    if (kind === "select") s += " options: " + [...el.options].slice(0, 12).map((o) => (o.selected ? "*" : "") + o.text.trim()).join(" | ");
    if (kind === "link") { const h = el.getAttribute("href") || ""; if (h && !h.startsWith("javascript:")) s += " -> " + h.slice(0, 120); }
    if (el.disabled) s += " (disabled)";
    return s;
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (cut) return;
      if (child.nodeType === 3) { line += " " + child.textContent; continue; }
      if (child.nodeType !== 1) continue;
      const el = child;
      if (SKIP.has(el.tagName)) continue;
      if (!visible(el)) continue;
      const kind = interactive(el);
      if (kind) { flush(); push(describe(el, kind)); continue; }
      if (/^H[1-6]$/.test(el.tagName)) { flush(); const t = el.innerText.replace(/\\s+/g, " ").trim(); if (t) push("#".repeat(Number(el.tagName[1])) + " " + t); continue; }
      if (el.tagName === "IMG") { const a = (el.getAttribute("alt") || "").trim(); if (a) line += " [image: " + a.slice(0, 80) + "]"; continue; }
      if (el.tagName === "IFRAME") { flush(); push("[iframe " + (el.getAttribute("title") || el.src || "").slice(0, 100) + "]"); continue; }
      const block = BLOCK.test(el.tagName);
      if (block) flush();
      if (el.shadowRoot) walk(el.shadowRoot);
      walk(el);
      if (block) flush();
    }
  };
  walk(document.body || document.documentElement);
  flush();
  window.__obRef = n;
  return { title: document.title, url: location.href, text: lines.join("\\n"), cut, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight } };
})()`;

export class Browser {
  private cdp?: Cdp;
  private starting?: Promise<Cdp>;
  private tabs: Tab[] = [];
  private active = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;

  /**
   * `spawn` starts the browser with the given flags (see PIPE_SCRIPT); `profile` and `downloads` are
   * as the browser sees them (inside the computer).
   */
  constructor(
    private spawn: (flags: string[]) => Subprocess<"pipe", "pipe", "pipe">,
    private profile: string,
    private downloads: string,
  ) {}

  get running() {
    return !!this.cdp && !this.cdp.closed;
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE);
    this.idleTimer.unref?.();
  }

  private async connection(): Promise<Cdp> {
    this.touch();
    if (this.cdp && !this.cdp.closed) return this.cdp;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const cdp = new Cdp(this.spawn(browserFlags(this.profile)));
      try {
        await cdp.send("Browser.getVersion", {}, undefined, 20_000);
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: this.downloads }).catch(() => {});
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        cdp.on((method, params) => {
          if (method === "Target.targetDestroyed") this.removeTab(params.targetId);
          // A page that opens a new tab (target=_blank): follow it, as a person would.
          if (method === "Target.targetCreated" && params.targetInfo?.type === "page" && params.targetInfo.openerId && !this.tabs.some((t) => t.targetId === params.targetInfo.targetId)) {
            this.tabs.push({ targetId: params.targetInfo.targetId });
            this.active = this.tabs.length - 1;
          }
        });
        // An alert or confirm would block the page until someone answers it.
        cdp.on((method, _params, sessionId) => {
          if (method === "Page.javascriptDialogOpening" && sessionId) void cdp.send("Page.handleJavaScriptDialog", { accept: true }, sessionId).catch(() => {});
        });
        const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
        this.tabs = targetInfos.filter((t) => t.type === "page").map((t) => ({ targetId: t.targetId }));
        if (!this.tabs.length) {
          const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
          this.tabs = [{ targetId }];
        }
        this.active = 0;
        this.cdp = cdp;
        return cdp;
      } catch (err) {
        cdp.kill();
        throw new Error(`Couldn't start the browser: ${(err as Error).message}`);
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  /** The active tab, attached and ready for Page/Runtime/Input commands. */
  private async page(): Promise<{ cdp: Cdp; session: string; tab: Tab }> {
    const cdp = await this.connection();
    if (!this.tabs.length) {
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      this.tabs = [{ targetId }];
      this.active = 0;
    }
    this.active = Math.min(this.active, this.tabs.length - 1);
    const tab = this.tabs[this.active]!;
    if (!tab.sessionId) {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
      tab.sessionId = sessionId;
      await Promise.all([
        cdp.send("Page.enable", {}, sessionId),
        cdp.send("Runtime.enable", {}, sessionId),
        cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false }, sessionId),
      ]);
    }
    return { cdp, session: tab.sessionId, tab };
  }

  private async evaluate<T = any>(expression: string, timeoutMs = 15_000): Promise<T> {
    const { cdp, session } = await this.page();
    const r = await cdp.send<{ result: { value?: T; description?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      session,
      timeoutMs,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /** Wait for a load that may or may not start (after a click), and for the page to settle. */
  private async settle(cdp: Cdp, session: string, navigating: boolean) {
    if (navigating) await cdp.waitFor("Page.loadEventFired", (_p, s) => s === session, 15_000);
    else {
      const started = await cdp.waitFor("Page.frameStartedLoading", (_p, s) => s === session, 600);
      if (started) await cdp.waitFor("Page.loadEventFired", (_p, s) => s === session, 15_000);
    }
    await Bun.sleep(350);
  }

  async open(url: string, newTab = false) {
    let target = url.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`;
    if (newTab) {
      const cdp = await this.connection();
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      this.tabs.push({ targetId });
      this.active = this.tabs.length - 1;
    }
    const { cdp, session } = await this.page();
    const loaded = cdp.waitFor("Page.loadEventFired", (_p, s) => s === session, 20_000);
    const r = await cdp.send<{ errorText?: string }>("Page.navigate", { url: target }, session, 30_000);
    if (r.errorText) throw new Error(`Couldn't open ${target}: ${r.errorText}`);
    await loaded;
    await Bun.sleep(400);
    return this.summary();
  }

  async history(direction: "back" | "forward" | "reload") {
    const { cdp, session } = await this.page();
    if (direction === "reload") {
      const loaded = cdp.waitFor("Page.loadEventFired", (_p, s) => s === session, 20_000);
      await cdp.send("Page.reload", {}, session);
      await loaded;
    } else {
      const h = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, session);
      const entry = h.entries[h.currentIndex + (direction === "back" ? -1 : 1)];
      if (!entry) throw new Error(`There's no page to go ${direction} to.`);
      const loaded = cdp.waitFor("Page.loadEventFired", (_p, s) => s === session, 15_000);
      await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session);
      await loaded;
    }
    await Bun.sleep(300);
    return this.summary();
  }

  async summary() {
    return this.evaluate<{ title: string; url: string }>("({ title: document.title, url: location.href })");
  }

  async snapshot(max = SNAPSHOT_MAX) {
    return this.evaluate<{ title: string; url: string; text: string; cut: boolean; scroll: { y: number; height: number; view: number } }>(SNAPSHOT_JS(Math.min(Math.max(max, 1000), 40_000)), 20_000);
  }

  /** The middle of an element, scrolled into view; throws when the ref is gone. */
  private async point(ref: string): Promise<{ x: number; y: number }> {
    const p = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector('[data-ob-ref="${ref.replace(/[^0-9]/g, "")}"]'); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!p) throw new Error(`Nothing on the page has ref [${ref}] anymore. Take a new browser_snapshot.`);
    return p;
  }

  async click(ref: string) {
    const { cdp, session } = await this.page();
    const { x, y } = await this.point(ref);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, session);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, session);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, session);
    await this.settle(cdp, session, false);
    return this.summary();
  }

  async type(ref: string, text: string, opts: { submit?: boolean; replace?: boolean } = {}) {
    const { cdp, session } = await this.page();
    const ok = await this.evaluate<boolean>(
      `(() => { const el = document.querySelector('[data-ob-ref="${ref.replace(/[^0-9]/g, "")}"]'); if (!el) return false; el.scrollIntoView({ block: "center" }); el.focus(); ${
        opts.replace === false
          ? ""
          : `if ("value" in el && typeof el.select === "function") el.select(); else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }`
      } return true; })()`,
    );
    if (!ok) throw new Error(`Nothing on the page has ref [${ref}] anymore. Take a new browser_snapshot.`);
    if (opts.replace !== false) await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, session).then(() => cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, session));
    await cdp.send("Input.insertText", { text }, session);
    if (opts.submit) return this.press("Enter");
    await Bun.sleep(150);
    return this.summary();
  }

  /** A key or chord: "Enter", "Tab", "ArrowDown", "Ctrl+A", "a". */
  async press(combo: string) {
    const { cdp, session } = await this.page();
    const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
    const keyName = parts.pop() ?? "";
    let modifiers = 0;
    for (const m of parts) modifiers |= MODIFIERS[m.toLowerCase()] ?? 0;
    const named = Object.keys(KEYS).find((k) => k.toLowerCase() === keyName.toLowerCase());
    const known = named ? KEYS[named] : undefined;
    const key = named ?? keyName;
    if (!known && key.length !== 1) throw new Error(`Unknown key "${keyName}". Use Enter, Tab, Escape, Backspace, Delete, arrows, PageUp/PageDown, Home, End, Space, or one character.`);
    const code = known?.code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : "");
    const keyCode = known?.keyCode ?? key.toUpperCase().charCodeAt(0);
    const text = modifiers & ~8 ? undefined : (known?.text ?? (known ? undefined : key));
    await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, text }, session);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers }, session);
    await this.settle(cdp, session, false);
    return this.summary();
  }

  async scroll(direction: "up" | "down", amount = 0.8) {
    const { cdp, session } = await this.page();
    const dy = Math.round(VIEWPORT.height * Math.min(Math.max(amount, 0.1), 5)) * (direction === "up" ? -1 : 1);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEWPORT.width / 2, y: VIEWPORT.height / 2, deltaX: 0, deltaY: dy }, session);
    await Bun.sleep(300);
    return this.evaluate<{ y: number; height: number; view: number }>("({ y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight })");
  }

  async screenshot(fullPage = false): Promise<{ data: string; mimeType: string; title: string; url: string }> {
    const { cdp, session } = await this.page();
    const r = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 72, captureBeyondViewport: fullPage }, session, 30_000);
    return { data: r.data, mimeType: "image/jpeg", ...(await this.summary()) };
  }

  async evaluateScript(script: string) {
    const value = await this.evaluate(`(async () => { ${/\breturn\b/.test(script) ? script : `return (${script})`} })()`, 30_000);
    return value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  async listTabs(): Promise<{ title: string; url: string; active: boolean }[]> {
    if (!this.running) return [];
    const cdp = await this.connection();
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; title: string; url: string }[] }>("Target.getTargets");
    const info = new Map(targetInfos.map((t) => [t.targetId, t]));
    this.tabs = this.tabs.filter((t) => info.has(t.targetId));
    return this.tabs.map((t, i) => ({ title: info.get(t.targetId)?.title ?? "", url: info.get(t.targetId)?.url ?? "", active: i === this.active }));
  }

  async switchTab(index: number) {
    const cdp = await this.connection();
    if (!this.tabs[index]) throw new Error(`There's no tab ${index + 1}.`);
    this.active = index;
    await cdp.send("Target.activateTarget", { targetId: this.tabs[index]!.targetId }).catch(() => {});
    return this.summary();
  }

  /** Events can remove a tab before closeTarget answers. Always remove by identity, once. */
  private removeTab(targetId: string) {
    const index = this.tabs.findIndex((tab) => tab.targetId === targetId);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    if (index < this.active) this.active--;
    this.active = Math.max(0, Math.min(this.active, this.tabs.length - 1));
  }

  async closeTab(index: number) {
    const cdp = await this.connection();
    const tab = this.tabs[index];
    if (!tab) throw new Error(`There's no tab ${index + 1}.`);
    await cdp.send("Target.closeTarget", { targetId: tab.targetId });
    this.removeTab(tab.targetId);
  }

  close() {
    clearTimeout(this.idleTimer);
    this.cdp?.kill();
    this.cdp = undefined;
    this.tabs = [];
  }
}

export { CdpError };
