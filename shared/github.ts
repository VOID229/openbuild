// Signing in to GitHub through OpenBuild's GitHub App: what the server and the app share. The app is
// registered once, by whoever publishes OpenBuild (its developer account); each user then installs
// it on their personal account or on organizations and picks the repositories there. Tokens come
// from GitHub's device flow, which needs only the public client ID. See docs/github.md.

/**
 * The published app. Empty until it's registered: a server can set its own with
 * OPENBUILD_GITHUB_APP_CLIENT_ID and OPENBUILD_GITHUB_APP_SLUG.
 */
export const GITHUB_APP = { clientId: "", slug: "" };

/** Which credential OpenBuild's GitHub features use. Only one at a time, and never the other one as a fallback. */
export type GithubMode = "app" | "pat" | "off";

/** Where the GitHub App is installed: an account (a person or an organization) and what it reaches there. */
export interface GithubInstallation {
  id: number;
  account: string;
  accountType: "User" | "Organization";
  /** "all" repositories of the account, or only the "selected" ones. */
  repositorySelection: "all" | "selected";
  /** The selected repositories the user can reach, when the selection is "selected". */
  repositories?: { name: string; private: boolean }[];
  /** More selected repositories than were listed. */
  moreRepositories?: number;
  suspended: boolean;
  /** Where its owner changes the repositories or uninstalls it. */
  manageUrl: string;
}

/** GitHub as the app sees it. Never holds a token. */
export interface GithubView {
  /** A client ID is set, so the GitHub App can be connected. */
  configured: boolean;
  mode: GithubMode;
  /** No choice was made yet: the old personal access token setup, as before. */
  legacy: boolean;
  /** A personal access token is saved (in Settings or the GitHub app). */
  hasPat: boolean;
  app?: {
    login: string;
    userId: number;
    /** The sign-in lapsed or was revoked: connect again. */
    signedOut: boolean;
    /** When the refresh token runs out (ms), if the app's tokens expire. */
    refreshExpiresAt?: number;
  };
  /** Install the app on the user's own account. */
  installPersonalUrl?: string;
  /** Install it on an organization (GitHub lists the ones the user may install on or request for). */
  installOrgUrl?: string;
}

export type DeviceStatus =
  | { status: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { status: "connected"; login: string }
  | { status: "denied" | "expired" | "cancelled" | "error"; error?: string };

export const GITHUB_AUTHORIZATIONS_URL = "https://github.com/settings/apps/authorizations";

export function installUrls(slug: string, userId?: number) {
  const base = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
  return { personal: userId ? `${base}/permissions?target_id=${userId}` : base, org: base };
}

export function manageUrl(installation: { id: number; account: string; accountType: string }): string {
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.account)}/settings/installations/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`;
}

const READ_VERB = /(^|_)(get|list|search|read)(_|$)/;
const WRITE_VERB = /(^|_)(create|update|delete|write|edit|merge|add|remove|push|run|rerun|cancel|dismiss|assign|request|submit|fork|close|reopen|lock|unlock|star|unstar|mark|manage|set|reprioritize|resolve)(_|$)/;

/**
 * Whether OpenBuild's read-only rule lets a bot run a GitHub tool: the server must mark it read-only
 * and its name must say it reads. Anything else, including a tool nobody has seen, counts as a write.
 */
export function isReadTool(name: string, tool: { readOnly?: boolean } | undefined): boolean {
  // "pull_request" names a thing, not the verb "request".
  const words = name.replace(/pull_requests?/g, "pr");
  return tool?.readOnly === true && READ_VERB.test(words) && !WRITE_VERB.test(words);
}
