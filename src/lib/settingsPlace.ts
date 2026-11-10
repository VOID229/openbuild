import type { SettingsSection } from "./store";

/**
 * Where Settings was left: its section, the page inside it and how far down it was. Opened again soon
 * after, Settings goes back there; after a while it starts over, at Profile's top.
 */
export interface SettingsPlace {
  section: SettingsSection;
  page?: string;
  index: boolean;
  scroll: number;
  at: number;
}

/** How long Settings remembers where it was left. */
export const SETTINGS_KEEP_MS = 10_000;

let left: SettingsPlace | undefined;

/** Settings closed here (SettingsPage, as it goes). */
export function leaveSettingsAt(place: Omit<SettingsPlace, "at">, now = Date.now()) {
  left = { ...place, at: now };
}

/** Where to open Settings again, if it was left recently enough. */
export function settingsPlace(now = Date.now()): SettingsPlace | undefined {
  return left && now - left.at < SETTINGS_KEEP_MS ? left : undefined;
}

/** A scroll offset to put back, once: the section it belongs to, and the offset. */
let pendingScroll: { section: SettingsSection; page?: string; scroll: number } | undefined;
export function takeSettingsScroll(section: SettingsSection, page?: string): number | undefined {
  const p = pendingScroll;
  pendingScroll = undefined;
  return p && p.section === section && p.page === page ? p.scroll : undefined;
}
export function reopenSettingsScroll(place: SettingsPlace | undefined) {
  pendingScroll = place && { section: place.section, page: place.page, scroll: place.scroll };
}
