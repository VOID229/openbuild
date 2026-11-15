// Updating OpenBuild from the app: what the server says about releases (`/api/releases`), and the
// words `ob update` prints as it goes, which the app reads back as progress. The app's update is that
// command, run by the server (server/pi/routes.ts), so its steps are named once, here.

import { channelName, parseVersionTag, type ReleaseChannel } from "./version";

/** How often an open app asks for a newer release. */
export const RELEASE_CHECK_EVERY = 5 * 60_000;

export type UpdateStep = "check" | "download" | "install";
export const UPDATE_STEPS: readonly UpdateStep[] = ["check", "download", "install"];
/** What `ob update` shows for each step: a line of its own when it isn't drawing the animated stage. */
export const UPDATE_STEP_LABEL: Record<UpdateStep, string> = {
  check: "Checking for a new release",
  download: "Downloading",
  install: "Installing dependencies",
};

/** The step a line of `ob update`'s output starts, if it starts one ("Downloading 0.1.9-nightly…"). */
export function updateStepOf(line: string): UpdateStep | undefined {
  const text = line.trim();
  return UPDATE_STEPS.find((step) => text === `${UPDATE_STEP_LABEL[step]}…` || text.startsWith(`${UPDATE_STEP_LABEL[step]} `));
}

/** The line that starts a step. */
export function updateStepLine(step: UpdateStep, tag?: string): string {
  return `${UPDATE_STEP_LABEL[step]}${tag ? ` ${tag}` : ""}…`;
}

/** What changed between the running release and the one on offer: commit subjects, newest first. */
export interface ReleaseChanges {
  /** At most CHANGES_SHOWN of them. */
  changes: string[];
  /** How many there are in all. */
  total: number;
}

/** `GET /api/releases`. */
export interface ReleaseCheck {
  track?: ReleaseChannel;
  /** The tag the checkout is at: the running release, or the installed one that waits for a restart. */
  current?: string;
  /** The newest release on the track. */
  latest?: string;
  available?: boolean;
  url?: string;
  changes?: ReleaseChanges;
  restart?: { pending: boolean; head?: string; error?: string };
  /** The update that is installing right now: its maintenance job. */
  updating?: string;
  /** Why the check failed. */
  error?: string;
}

/**
 * A change as the changelog lists it, from its commit subject: without the conventional prefix
 * ("feat(bots): ") and the pull request's number (" (#351)"), starting with a capital.
 */
export function changeText(subject: string): string {
  const text = subject.trim().replace(/\s*\(#\d+\)$/, "").replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/, "");
  return text ? text[0]!.toUpperCase() + text.slice(1) : subject.trim();
}

/** "Nightly 0.1.9" for the tag "0.1.9-nightly", "Stable 0.1.9" for "0.1.9"; any other tag as it is. */
export function tagLabel(tag: string): string {
  const v = parseVersionTag(tag);
  return v ? `${channelName(v.stable ? "stable" : "nightly")} ${v.version}` : tag;
}

/** "0.1.9" for either of its tags. */
export function tagVersion(tag: string): string {
  return parseVersionTag(tag)?.version ?? tag;
}
