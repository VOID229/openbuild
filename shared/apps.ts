// The apps OpenBots can connect: official MCP servers and agent skills, each run or published by
// the service itself. The list follows the Connect apps catalog in Grok Bot (Cursor's plugin
// marketplace), keeping the entries whose own publisher hosts the server, and leaving out the ones
// only Cursor can reach (its api.cursor.com proxies) or that only admit partner clients. Every
// entry here is checked by `bun scripts/check-apps.ts`: the server answers, its sign-in can be
// discovered, and the skills are where the pin says.
//
// Connections are account-wide, the way Grok Bot does it: an app the user connects is there for
// every bot. The server holds the sign-in; bots call tools through it and never see a token.

export type AppCategory = "passwords" | "productivity" | "communication" | "design" | "code" | "data" | "payments";

/** In the order the catalog shows them. The ones marked `more` sit behind the More menu. */
export const APP_CATEGORIES: { id: AppCategory; label: string; more?: boolean }[] = [
  { id: "passwords", label: "Password Managers" },
  { id: "productivity", label: "Productivity" },
  { id: "communication", label: "Communication" },
  { id: "design", label: "Design" },
  { id: "code", label: "Code" },
  { id: "data", label: "Data & Analytics", more: true },
  { id: "payments", label: "Payments", more: true },
];

/** A folder of skills (each a folder with a SKILL.md) in the publisher's repository, pinned to a commit. */
export interface SkillSource {
  /** owner/name on GitHub. */
  repo: string;
  /** A full commit sha, so what installs is what was checked. */
  ref: string;
  /** The folder holding the skill folders; "" for the repository's root. */
  dir: string;
}

/** Something the user fills in to connect: a key, or a setting such as a region. */
export interface AppField {
  id: string;
  label: string;
  /** Kept in the vault and never shown again. Settings that aren't secret stay visible. */
  secret?: boolean;
  placeholder?: string;
  help?: string;
  /** Where to get it. */
  link?: string;
  /** A choice rather than text. The first is the default. */
  options?: { value: string; label: string }[];
}

/** Services without self-registration: they sign in through an OAuth app registered once per service, by the server or the user. */
export type OAuthClientId = "google" | "slack" | "asana" | "microsoft";

export interface OAuthClientGuide {
  name: string;
  /** Where the app is registered. */
  console: string;
  docs: string;
  /** A public client (PKCE only) can do without a secret. */
  secret: "required" | "optional";
  /** Set where the server runs instead of pasted in: the environment variables holding the client. */
  env?: { id: string; secret: string };
  /** How to register one to paste in, for services without `env`. */
  steps?: string[];
}

export const OAUTH_CLIENTS: Record<OAuthClientId, OAuthClientGuide> = {
  google: {
    name: "Google Cloud",
    console: "https://console.cloud.google.com/auth/clients",
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    secret: "required",
    env: { id: "GOOGLE_OAUTH_CLIENT_ID", secret: "GOOGLE_OAUTH_CLIENT_SECRET" },
  },
  slack: {
    name: "Slack",
    console: "https://api.slack.com/apps",
    docs: "https://docs.slack.dev/ai/slack-mcp-server",
    secret: "required",
    steps: [
      "Create a Slack app from scratch in your own workspace. Slack lets internal and Marketplace apps use its MCP server, not unlisted ones.",
      "Under OAuth & Permissions, add the redirect URL below and the user token scopes from Slack's MCP guide.",
      "Slack wants an https redirect. For an http://localhost one, turn on PKCE for the app first.",
      "Install the app to your workspace, then paste its client ID and secret.",
    ],
  },
  asana: {
    name: "Asana",
    console: "https://app.asana.com/0/my-apps",
    docs: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
    secret: "required",
    steps: [
      "In Asana's developer console, create a new app and pick MCP app as its type.",
      "Add the redirect URL below on its OAuth tab.",
      "Under Manage distribution, choose the workspaces it may use.",
      "Paste its client ID and secret.",
    ],
  },
  microsoft: {
    name: "Microsoft Entra",
    console: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    docs: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview",
    secret: "optional",
    steps: [
      "Work IQ is for work and school accounts. An admin has to turn it on for your organization first.",
      "Register an app in Microsoft Entra and add the redirect URI below.",
      "Under API permissions, add Work IQ's delegated WorkIQAgent.Ask permission and grant admin consent.",
      "Paste its application (client) ID, and a client secret if you made one.",
    ],
  },
};

export type AppConnection =
  /** Signs in with OAuth and registers itself with the service. */
  | { kind: "oauth"; url: string; scopes?: string[] }
  /** Signs in with OAuth through an app the user registered (see OAUTH_CLIENTS). */
  | { kind: "client"; url: string; client: OAuthClientId; scopes?: string[]; /** APIs to turn on in the user's project. */ enable?: string[] }
  /** Keys the user pastes, sent as headers. `{field}` in a header takes that field's value. */
  | { kind: "token"; url: string; headers: Record<string, string> }
  /** Open to anyone: no sign-in. */
  | { kind: "open"; url: string }
  /** A program on the computer OpenBuild runs on, which brings its own sign-in. */
  | { kind: "local"; command: string; args?: string[]; install: string }
  /** A server a desktop app runs on this computer. */
  | { kind: "desktop"; url: string; install: string };

export interface CatalogApp {
  id: string;
  name: string;
  /** Who runs the server and publishes the skills. */
  by: string;
  description: string;
  category: AppCategory;
  /** The publisher's own page about connecting it. */
  docs: string;
  connection: AppConnection;
  /** `{id}` in the connection's url or headers takes a field's value. */
  fields?: AppField[];
  skills?: SkillSource[];
  /** Shown under Recommended until it's connected. */
  recommended?: boolean;
}

const google = (scopes: string[], enable: string[]) => ({ client: "google" as const, scopes: scopes.map((s) => (s.startsWith("https://") ? s : `https://www.googleapis.com/auth/${s}`)), enable });

export const APP_CATALOG: CatalogApp[] = [
  // ------------------------------------------------------------ password managers
  {
    id: "1password",
    name: "1Password",
    by: "1Password",
    description: "Create, import and mount project secrets from 1Password Environments, approving each request in the 1Password app.",
    category: "passwords",
    docs: "https://www.1password.dev/environments/mcp-server",
    connection: { kind: "local", command: "1password-mcp", install: "Install the 1Password desktop app (macOS or Linux) on this computer and turn on Settings → Developer → Integrate with MCP clients." },
    skills: [{ repo: "1Password/cursor-plugin", ref: "d0e17cdd8ac501abea9f839c4c9353fd4993c707", dir: "skills" }],
  },

  // ------------------------------------------------------------ productivity
  {
    id: "notion",
    name: "Notion",
    by: "Notion",
    description: "Search, read and update pages, databases and comments.",
    category: "productivity",
    docs: "https://developers.notion.com/docs/mcp",
    connection: { kind: "oauth", url: "https://mcp.notion.com/mcp" },
    skills: [{ repo: "makenotion/cursor-notion-plugin", ref: "cf1324609edba6d617164f1dec138aeb43f26735", dir: "skills" }],
  },
  {
    id: "linear",
    name: "Linear",
    by: "Linear",
    description: "Find, create and update issues, projects and comments.",
    category: "productivity",
    docs: "https://linear.app/docs/mcp",
    connection: { kind: "oauth", url: "https://mcp.linear.app/mcp" },
    recommended: true,
  },
  {
    id: "atlassian",
    name: "Atlassian",
    by: "Atlassian",
    description: "Search and update Jira issues and Confluence pages.",
    category: "productivity",
    docs: "https://www.atlassian.com/platform/remote-mcp-server",
    connection: { kind: "oauth", url: "https://mcp.atlassian.com/v2/mcp" },
    skills: [{ repo: "atlassian/atlassian-mcp-server", ref: "9de1ab435251042efbb6839a1ca748eacecf4727", dir: "skills" }],
  },
  {
    id: "trello",
    name: "Trello",
    by: "Atlassian",
    description: "Work with boards, lists and cards.",
    category: "productivity",
    docs: "https://www.atlassian.com/platform/remote-mcp-server",
    connection: { kind: "oauth", url: "https://mcp.trello.com/v1" },
  },
  {
    id: "asana",
    name: "Asana",
    by: "Asana",
    description: "Search, create and update tasks, projects and goals.",
    category: "productivity",
    docs: "https://developers.asana.com/docs/using-asanas-mcp-server",
    connection: { kind: "client", url: "https://mcp.asana.com/v2/mcp", client: "asana" },
    skills: [{ repo: "Asana/cursor-marketplace-plugin", ref: "caf02337846594b6af5221ea5165c1dd0d273d9b", dir: "skills" }],
  },
  {
    id: "clickup",
    name: "ClickUp",
    by: "ClickUp",
    description: "Manage tasks, docs, comments and time tracking.",
    category: "productivity",
    docs: "https://github.com/clickup/clickup-plugin",
    connection: { kind: "oauth", url: "https://mcp.clickup.com/mcp" },
    skills: [{ repo: "clickup/clickup-plugin", ref: "1f40631e03a8d3b393ad67a39eaae599fe9669c9", dir: "skills" }],
  },
  {
    id: "monday",
    name: "monday.com",
    by: "monday.com",
    description: "Work with boards, items, updates and docs.",
    category: "productivity",
    docs: "https://github.com/mondaycom/mcp",
    connection: { kind: "oauth", url: "https://mcp.monday.com/mcp" },
    skills: [{ repo: "mondaycom/mcp", ref: "1547999db24d5e80a3ab348b443453558cc8f517", dir: "plugins/monday-crm/skills" }],
  },
  {
    id: "airtable",
    name: "Airtable",
    by: "Airtable",
    description: "Read and update bases, tables and records.",
    category: "productivity",
    docs: "https://github.com/Airtable/skills",
    connection: { kind: "oauth", url: "https://mcp.airtable.com/mcp" },
    skills: [{ repo: "Airtable/skills", ref: "812ee67f1fd3d76fb45ff8df40afaa0448602ba8", dir: "plugins/airtable/skills" }],
  },
  {
    id: "todoist",
    name: "Todoist",
    by: "Doist",
    description: "Create, find and complete tasks and projects.",
    category: "productivity",
    docs: "https://github.com/Doist/todoist-ai",
    connection: { kind: "oauth", url: "https://ai.todoist.net/mcp" },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    by: "Google",
    description: "Look up events and free time, and schedule meetings.",
    category: "productivity",
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    connection: { kind: "client", url: "https://calendarmcp.googleapis.com/mcp/v1", ...google(["calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events"], ["calendar-json.googleapis.com", "calendarmcp.googleapis.com"]) },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    by: "Google",
    description: "Search, read and create files.",
    category: "productivity",
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    connection: { kind: "client", url: "https://drivemcp.googleapis.com/mcp/v1", ...google(["drive.readonly", "drive.file"], ["drive.googleapis.com", "drivemcp.googleapis.com"]) },
  },
  {
    id: "google-docs",
    name: "Google Docs",
    by: "Google",
    description: "Read, create and edit documents.",
    category: "productivity",
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    connection: { kind: "client", url: "https://docsmcp.googleapis.com/mcp/v1", ...google(["drive.readonly", "drive.file", "documents"], ["docs.googleapis.com", "docsmcp.googleapis.com"]) },
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    by: "Google",
    description: "Read, write and append spreadsheet data.",
    category: "productivity",
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    connection: { kind: "client", url: "https://sheetsmcp.googleapis.com/mcp/v1", ...google(["drive.readonly", "drive.file", "spreadsheets"], ["sheets.googleapis.com", "sheetsmcp.googleapis.com"]) },
  },
  {
    id: "google-slides",
    name: "Google Slides",
    by: "Google",
    description: "Create and edit presentations.",
    category: "productivity",
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    connection: { kind: "client", url: "https://slidesmcp.googleapis.com/mcp/v1", ...google(["drive.readonly", "drive.file", "presentations"], ["slides.googleapis.com", "slidesmcp.googleapis.com"]) },
  },
  {
    id: "calendly",
    name: "Calendly",
    by: "Calendly",
    description: "Check availability and book, cancel or reschedule meetings.",
    category: "productivity",
    docs: "https://developer.calendly.com/",
    connection: { kind: "oauth", url: "https://mcp.calendly.com/" },
  },

  // ------------------------------------------------------------ communication
  {
    id: "gmail",
    name: "Gmail",
    by: "Google",
    description: "Search, read and draft email.",
    category: "communication",
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    connection: { kind: "client", url: "https://gmailmcp.googleapis.com/mcp/v1", ...google(["gmail.readonly", "gmail.compose"], ["gmail.googleapis.com", "gmailmcp.googleapis.com"]) },
  },
  {
    id: "slack",
    name: "Slack",
    by: "Slack",
    description: "Search messages, read channels and threads, and post as you.",
    category: "communication",
    docs: "https://docs.slack.dev/ai/slack-mcp-server",
    connection: {
      kind: "client",
      url: "https://mcp.slack.com/mcp",
      client: "slack",
      scopes: ["search:read.public", "search:read.private", "search:read.mpim", "search:read.im", "search:read.files", "search:read.users", "chat:write", "channels:history", "groups:history", "mpim:history", "im:history", "canvases:read", "canvases:write", "users:read", "users:read.email", "reactions:read", "reactions:write"],
    },
    skills: [{ repo: "slackapi/slack-mcp-plugin", ref: "64c3f33fa13beb98c96d736390f80f3454a93a88", dir: "skills" }],
  },
  {
    id: "google-chat",
    name: "Google Chat",
    by: "Google",
    description: "Read spaces and messages, and send messages.",
    category: "communication",
    docs: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    connection: {
      kind: "client",
      url: "https://chatmcp.googleapis.com/mcp/v1",
      ...google(["chat.spaces.readonly", "chat.memberships.readonly", "chat.messages.readonly", "chat.messages.create", "chat.users.readstate", "chat.users.spacesettings"], ["chat.googleapis.com", "chatmcp.googleapis.com"]),
    },
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365",
    by: "Microsoft",
    description: "Outlook mail and calendar, Teams, OneDrive and SharePoint through Work IQ, for work and school accounts.",
    category: "communication",
    docs: "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview",
    connection: { kind: "client", url: "https://workiq.svc.cloud.microsoft/mcp", client: "microsoft", scopes: ["fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask", "offline_access"] },
  },
  {
    id: "intercom",
    name: "Intercom",
    by: "Intercom",
    description: "Search conversations, contacts and Help Center articles.",
    category: "communication",
    docs: "https://developers.intercom.com/docs/guides/mcp",
    connection: { kind: "oauth", url: "https://mcp.intercom.com/mcp" },
  },
  {
    id: "fireflies",
    name: "Fireflies",
    by: "Fireflies.ai",
    description: "Search meeting transcripts, summaries and action items.",
    category: "communication",
    docs: "https://docs.fireflies.ai/",
    connection: { kind: "oauth", url: "https://api.fireflies.ai/mcp" },
  },

  // ------------------------------------------------------------ design
  {
    id: "figma",
    name: "Figma",
    by: "Figma",
    description: "Read designs, variables and components from the Figma desktop app, and turn them into code.",
    category: "design",
    docs: "https://developers.figma.com/docs/figma-mcp-server/",
    connection: { kind: "desktop", url: "http://127.0.0.1:3845/mcp", install: "Open the Figma desktop app on this computer and turn on the desktop MCP server (Preferences → Enable desktop MCP server). It needs a Dev or Full seat." },
    skills: [{ repo: "figma/mcp-server-guide", ref: "f0493295acf5f7cbdebcbcc483c06de814420cb1", dir: "skills-figquery" }],
  },
  {
    id: "canva",
    name: "Canva",
    by: "Canva",
    description: "Find, create and edit designs, and export them.",
    category: "design",
    docs: "https://www.canva.dev/docs/connect/canva-mcp-server-setup/",
    connection: { kind: "oauth", url: "https://mcp.canva.com/mcp" },
    skills: [{ repo: "canva-sdks/canva-skills", ref: "906e8e0b0808e7146b998a48179abef281be57ca", dir: "plugins/canva/skills" }],
  },
  {
    id: "miro",
    name: "Miro",
    by: "Miro",
    description: "Read boards and create diagrams, docs and tables on them.",
    category: "design",
    docs: "https://developers.miro.com/docs/miro-mcp",
    connection: { kind: "oauth", url: "https://mcp.miro.com/" },
    skills: [{ repo: "miroapp/miro-ai", ref: "9627168a40c694c61a8734cbcdd452d21e560bdc", dir: "cursor-plugins/miro/skills" }],
  },
  {
    id: "framer",
    name: "Framer",
    by: "Framer",
    description: "Edit pages, components and CMS content in a Framer project.",
    category: "design",
    docs: "https://www.framer.com/",
    connection: { kind: "oauth", url: "https://mcp.framer.com/mcp" },
  },
  {
    id: "webflow",
    name: "Webflow",
    by: "Webflow",
    description: "Manage sites, pages, CMS collections and components.",
    category: "design",
    docs: "https://developers.webflow.com/mcp/reference/overview",
    connection: { kind: "oauth", url: "https://mcp.webflow.com/mcp" },
    skills: [{ repo: "webflow/webflow-skills", ref: "62181e454a1ed72a7f9788ddbc59b3404d6140fd", dir: "plugins/webflow-skills/skills" }],
  },
  {
    id: "excalidraw",
    name: "Excalidraw",
    by: "Excalidraw",
    description: "Sketch hand-drawn diagrams and whiteboards.",
    category: "design",
    docs: "https://excalidraw.com/",
    connection: { kind: "open", url: "https://mcp.excalidraw.com/mcp" },
  },

  // ------------------------------------------------------------ code
  {
    id: "github",
    name: "GitHub",
    by: "GitHub",
    description: "Manage repos, issues, pull requests and Actions.",
    category: "code",
    docs: "https://github.com/github/github-mcp-server",
    connection: { kind: "token", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer {token}" } },
    fields: [{ id: "token", label: "Personal access token", secret: true, placeholder: "github_pat_…", link: "https://github.com/settings/personal-access-tokens/new", help: "A fine-grained or classic token, with the access you want bots to have." }],
    recommended: true,
  },
  {
    id: "gitlab",
    name: "GitLab",
    by: "GitLab",
    description: "Search and manage issues, merge requests and pipelines on GitLab.com.",
    category: "code",
    docs: "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
    connection: { kind: "oauth", url: "https://gitlab.com/api/v4/mcp" },
  },
  {
    id: "vercel",
    name: "Vercel",
    by: "Vercel",
    description: "Look into projects, deployments and logs, and search Vercel's docs.",
    category: "code",
    docs: "https://vercel.com/docs/mcp/vercel-mcp",
    connection: { kind: "oauth", url: "https://mcp.vercel.com" },
    skills: [{ repo: "vercel/vercel-plugin", ref: "3b472643cbb1a42479d99b0c9a1d27b8bc84aaa7", dir: "skills" }],
    recommended: true,
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    by: "Cloudflare",
    description: "Work with Workers, DNS, storage and the rest of your account through Cloudflare's API.",
    category: "code",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    connection: { kind: "oauth", url: "https://mcp.cloudflare.com/mcp" },
    skills: [{ repo: "cloudflare/skills", ref: "41e0d19858946d18af9ee2c2feebbe2e11d829ff", dir: "skills" }],
    recommended: true,
  },
  {
    id: "supabase",
    name: "Supabase",
    by: "Supabase",
    description: "Manage projects, run SQL, apply migrations and read logs.",
    category: "code",
    docs: "https://supabase.com/docs/guides/getting-started/mcp",
    connection: { kind: "oauth", url: "https://mcp.supabase.com/mcp" },
    skills: [{ repo: "supabase/agent-skills", ref: "e5f7a7cfd697765848ffd6a4505f3c02e1ee17ee", dir: "skills" }],
    recommended: true,
  },
  {
    id: "firebase",
    name: "Firebase",
    by: "Firebase",
    description: "Manage Firebase projects, apps, auth, Firestore and rules with the Firebase CLI.",
    category: "code",
    docs: "https://firebase.google.com/docs/ai-assistance/mcp-server",
    connection: { kind: "local", command: "npx", args: ["-y", "firebase-tools@latest", "mcp"], install: "Install Node.js on this computer and sign in with `npx firebase-tools login`." },
    skills: [{ repo: "firebase/agent-skills", ref: "1d7a55fbecfd3c37516e0ee53b6c1ee9ac206db8", dir: "skills" }],
  },
  {
    id: "sentry",
    name: "Sentry",
    by: "Sentry",
    description: "Look into issues, errors, traces and releases.",
    category: "code",
    docs: "https://docs.sentry.io/product/sentry-mcp/",
    connection: { kind: "oauth", url: "https://mcp.sentry.dev/mcp" },
    skills: [{ repo: "getsentry/plugin-cursor", ref: "135513f89f293c587fbffb852afdf00a256df32a", dir: "skills" }],
    recommended: true,
  },
  {
    id: "datadog",
    name: "Datadog",
    by: "Datadog",
    description: "Query logs, metrics, traces, monitors and incidents.",
    category: "code",
    docs: "https://docs.datadoghq.com/bits_ai/mcp_server/",
    connection: { kind: "oauth", url: "https://mcp.{site}/v1/mcp" },
    fields: [
      {
        id: "site",
        label: "Datadog site",
        options: [
          { value: "datadoghq.com", label: "US1 (datadoghq.com)" },
          { value: "us3.datadoghq.com", label: "US3" },
          { value: "us5.datadoghq.com", label: "US5" },
          { value: "datadoghq.eu", label: "EU (datadoghq.eu)" },
          { value: "ap1.datadoghq.com", label: "AP1" },
          { value: "ap2.datadoghq.com", label: "AP2" },
        ],
      },
    ],
    skills: [{ repo: "datadog-labs/cursor-plugin", ref: "dde3591e9a6b78405b516965fc993b30f86baba0", dir: "skills" }],
  },
  {
    id: "netlify",
    name: "Netlify",
    by: "Netlify",
    description: "Create and manage sites, deploys and environment variables.",
    category: "code",
    docs: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
    connection: { kind: "oauth", url: "https://netlify-mcp.netlify.app/mcp" },
    skills: [{ repo: "netlify/context-and-tools", ref: "dfe1eb06b1ebbc4a17c66ed904ddc683168d5cd1", dir: "skills" }],
  },
  {
    id: "neon",
    name: "Neon",
    by: "Neon",
    description: "Create Postgres projects and branches, and run queries.",
    category: "code",
    docs: "https://neon.com/docs/ai/neon-mcp-server",
    connection: { kind: "oauth", url: "https://mcp.neon.tech/mcp" },
    skills: [{ repo: "neondatabase/agent-skills", ref: "9e4a5705922fddb540c396111a7979e0dca79cc2", dir: "plugins/neon-postgres/skills" }],
  },
  {
    id: "planetscale",
    name: "PlanetScale",
    by: "PlanetScale",
    description: "Manage databases and branches, and look into query insights.",
    category: "code",
    docs: "https://planetscale.com/docs",
    connection: { kind: "oauth", url: "https://mcp.pscale.dev/mcp/planetscale" },
    skills: [
      { repo: "planetscale/skills", ref: "999045cfbad79222f38a99599eb96bc736feabee", dir: "" },
      { repo: "planetscale/database-skills", ref: "73b20b7eb64716d8c7100c054f0677c0c6e77e30", dir: "skills" },
    ],
  },
  {
    id: "prisma",
    name: "Prisma",
    by: "Prisma",
    description: "Create and manage Prisma Postgres databases and backups.",
    category: "code",
    docs: "https://www.prisma.io/docs/postgres/integrations/mcp-server",
    connection: { kind: "oauth", url: "https://mcp.prisma.io/mcp" },
    skills: [{ repo: "prisma/cursor-plugin", ref: "17ded397536e131087cdfe1f8d723b3c91da31ce", dir: "skills" }],
  },
  {
    id: "railway",
    name: "Railway",
    by: "Railway",
    description: "Deploy services and manage projects, variables and logs.",
    category: "code",
    docs: "https://docs.railway.com/reference/mcp-server",
    connection: { kind: "oauth", url: "https://mcp.railway.com" },
    skills: [{ repo: "railwayapp/railway-skills", ref: "5d1e97178f86c82795d6737928bd641e0552166a", dir: "plugins/railway/skills" }],
  },
  {
    id: "render",
    name: "Render",
    by: "Render",
    description: "Manage services, databases, deploys, logs and metrics.",
    category: "code",
    docs: "https://render.com/docs/mcp-server",
    connection: { kind: "token", url: "https://mcp.render.com/mcp", headers: { Authorization: "Bearer {token}" } },
    fields: [{ id: "token", label: "API key", secret: true, placeholder: "rnd_…", link: "https://dashboard.render.com/u/settings#api-keys" }],
    skills: [{ repo: "render-oss/render-cursor-plugin", ref: "a4cad87982f39f64bdc828424c17f38310c89517", dir: "plugins/render/skills" }],
  },
  {
    id: "postman",
    name: "Postman",
    by: "Postman",
    description: "Work with collections, environments, specs and mock servers.",
    category: "code",
    docs: "https://www.postman.com/product/mcp-server",
    connection: { kind: "oauth", url: "https://mcp.postman.com/mcp" },
    skills: [{ repo: "postmanlabs/postman-plugin", ref: "e94d308f9603e168c814e9377257f82758daf550", dir: "skills" }],
  },
  {
    id: "clerk",
    name: "Clerk",
    by: "Clerk",
    description: "Manage applications, users and organizations.",
    category: "code",
    docs: "https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server",
    connection: { kind: "oauth", url: "https://mcp.clerk.com/mcp" },
    skills: [{ repo: "clerk/skills", ref: "a02dbd2a933b8929525129a6cb9dcf6ed66d0adf", dir: "skills" }],
  },
  {
    id: "resend",
    name: "Resend",
    by: "Resend",
    description: "Send email and manage domains, audiences and broadcasts.",
    category: "code",
    docs: "https://resend.com/docs/knowledge-base/mcp-server",
    connection: { kind: "oauth", url: "https://mcp.resend.com/mcp" },
    skills: [{ repo: "resend/resend-skills", ref: "4b1558df96241f0a7eb416a1ce262650f2a5f471", dir: "skills" }],
  },
  {
    id: "grafana",
    name: "Grafana Cloud",
    by: "Grafana Labs",
    description: "Query dashboards, metrics, logs and alerts in Grafana Cloud.",
    category: "code",
    docs: "https://github.com/grafana/ai-marketplace",
    connection: { kind: "oauth", url: "https://mcp.grafana.com/mcp" },
    skills: [{ repo: "grafana/ai-marketplace", ref: "0d0526a92f5e5546bdd9e84390100766cc61298f", dir: "plugins/grafana-cloud-mcp/skills" }],
  },
  {
    id: "azure",
    name: "Azure",
    by: "Microsoft",
    description: "Manage Azure resources with the Azure MCP server and your Azure CLI sign-in.",
    category: "code",
    docs: "https://learn.microsoft.com/azure/developer/azure-mcp-server/",
    connection: { kind: "local", command: "npx", args: ["-y", "@azure/mcp@latest", "server", "start"], install: "Install Node.js and the Azure CLI on this computer, and sign in with `az login`." },
    skills: [{ repo: "microsoft/azure-skills", ref: "9d86ae4a15bcbc82bd49d908c050638d99d02e38", dir: ".github/plugins/azure-skills/skills" }],
  },
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    by: "Microsoft",
    description: "Search Microsoft's documentation and code samples.",
    category: "code",
    docs: "https://learn.microsoft.com/en-us/training/support/mcp",
    connection: { kind: "open", url: "https://learn.microsoft.com/api/mcp" },
  },
  {
    id: "context7",
    name: "Context7",
    by: "Upstash",
    description: "Up-to-date docs and code examples for libraries and frameworks.",
    category: "code",
    docs: "https://github.com/upstash/context7",
    connection: { kind: "open", url: "https://mcp.context7.com/mcp" },
    skills: [{ repo: "upstash/context7", ref: "33414e6e3fc157c936348ca8ddba25e50dacaeee", dir: "plugins/cursor/context7/skills" }],
  },

  // ------------------------------------------------------------ data
  {
    id: "posthog",
    name: "PostHog",
    by: "PostHog",
    description: "Query product analytics, feature flags, experiments and errors.",
    category: "data",
    docs: "https://posthog.com/docs/model-context-protocol",
    connection: { kind: "oauth", url: "https://mcp.posthog.com/mcp" },
    skills: [{ repo: "PostHog/ai-plugin", ref: "db4a86632293ca66eec9a6d278786ddb22c1787e", dir: "skills" }],
  },
  {
    id: "mixpanel",
    name: "Mixpanel",
    by: "Mixpanel",
    description: "Ask questions of your product analytics.",
    category: "data",
    docs: "https://docs.mixpanel.com/docs/mcp",
    connection: { kind: "oauth", url: "https://mcp.mixpanel.com/mcp" },
    skills: [{ repo: "mixpanel/ai-plugins", ref: "c77b566dc539382036cfc6dcf8758ba7f0787df9", dir: "plugins/mixpanel-mcp/skills" }],
  },
  {
    id: "amplitude",
    name: "Amplitude",
    by: "Amplitude",
    description: "Search charts, dashboards, experiments and cohorts.",
    category: "data",
    docs: "https://docs.amplitude.com/mcp",
    connection: { kind: "oauth", url: "https://mcp.amplitude.com/mcp" },
    skills: [{ repo: "amplitude/mcp-marketplace", ref: "305bdd24b3e770484cf4c1c5b6a72334c68ba598", dir: "plugins/amplitude/skills" }],
  },
  {
    id: "hex",
    name: "Hex",
    by: "Hex",
    description: "Search projects and ask Hex's agent data questions.",
    category: "data",
    docs: "https://github.com/hex-inc/hex-cursor-plugin",
    connection: { kind: "oauth", url: "https://app.hex.tech/mcp" },
    skills: [{ repo: "hex-inc/hex-cursor-plugin", ref: "58b7f25fd332f6d5a3f928a9748b415bdb47d476", dir: "skills" }],
  },
  {
    id: "bigquery",
    name: "BigQuery",
    by: "Google Cloud",
    description: "List datasets and tables, and run SQL queries.",
    category: "data",
    docs: "https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp",
    connection: { kind: "client", url: "https://bigquery.googleapis.com/mcp", ...google(["bigquery"], ["bigquery.googleapis.com"]) },
  },
  {
    id: "google-maps",
    name: "Google Maps",
    by: "Google",
    description: "Look up places, routes and weather, grounded in Google Maps.",
    category: "data",
    docs: "https://developers.google.com/maps/ai/grounding-lite",
    connection: { kind: "client", url: "https://mapstools.googleapis.com/mcp", ...google(["maps-platform.mapstools"], ["mapstools.googleapis.com"]) },
  },

  // ------------------------------------------------------------ payments
  {
    id: "stripe",
    name: "Stripe",
    by: "Stripe",
    description: "Work with customers, payments, subscriptions and invoices, and search Stripe's docs.",
    category: "payments",
    docs: "https://docs.stripe.com/mcp",
    connection: { kind: "oauth", url: "https://mcp.stripe.com" },
    skills: [{ repo: "stripe/ai", ref: "e4856d5f871fb9c347db2ce8e5a96f6513393d11", dir: "providers/cursor/plugin/skills" }],
  },
  {
    id: "square",
    name: "Square",
    by: "Square",
    description: "Work with payments, orders, catalog, customers and inventory.",
    category: "payments",
    docs: "https://developer.squareup.com/docs/mcp",
    connection: { kind: "oauth", url: "https://mcp.squareup.com/mcp" },
  },
  {
    id: "paypal",
    name: "PayPal",
    by: "PayPal",
    description: "Create invoices, orders and subscriptions, and look into transactions.",
    category: "payments",
    docs: "https://developer.paypal.com/tools/mcp-server/",
    connection: { kind: "oauth", url: "https://mcp.paypal.com/mcp" },
    skills: [{ repo: "paypal/AI-Toolkit", ref: "89ac03f4f7fe27a45163ebeae44a61899735cdd4", dir: "skills" }],
  },
];

export const appById = (id: string) => APP_CATALOG.find((a) => a.id === id);

/** Fill `{field}` in a template. A field with options defaults to its first. */
export function fillTemplate(template: string, app: Pick<CatalogApp, "fields">, values: Record<string, string>): string {
  return template.replace(/\{([a-z0-9_]+)\}/gi, (whole, id: string) => {
    const field = app.fields?.find((f) => f.id === id);
    return values[id] ?? field?.options?.[0]?.value ?? whole;
  });
}

/** The address an app's server is reached at, with its settings filled in. Local programs have none. */
export function appUrl(app: CatalogApp, values: Record<string, string> = {}): string | undefined {
  return "url" in app.connection ? fillTemplate(app.connection.url, app, values) : undefined;
}

// ------------------------------------------------------------------ what the app sees

export type AppStatus = "off" | "connecting" | "connected" | "needs-auth" | "error";

export interface AppTool {
  name: string;
  title?: string;
  description?: string;
}

export interface AppSkill {
  name: string;
  description: string;
}

/** One app's state as Settings and the catalog show it. Secrets never leave the server. */
export interface AppView {
  id: string;
  status: AppStatus;
  error?: string;
  connectedAt?: number;
  /** Settings that aren't secret (a Datadog site). */
  fields?: Record<string, string>;
  tools?: AppTool[];
  skills?: AppSkill[];
}

export interface AppsSnapshot {
  apps: AppView[];
  /** The OAuth apps the user registered, by service. */
  clients: OAuthClientId[];
  /** A GitHub key in OpenBuild's settings that the GitHub app can use instead of a new one. */
  githubKey: boolean;
}

/** The path a service sends the user back to after signing in. */
export const APP_CALLBACK_PATH = "/api/bots/apps/callback";
