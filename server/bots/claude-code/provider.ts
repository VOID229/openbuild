import { createProvider, type AuthContext, type ProviderEnv } from "@earendil-works/pi-ai";
import { discoverClaudeModels, getClaudeStatus, LOGIN_HINT, POWERSHELL_ENV } from "./claude-cli.ts";
import { API_ID, CLAUDE_CODE_MODELS, modelFromDiscovery, PROVIDER_ID } from "./model-catalog.ts";
import { streamClaudeCode } from "./stream.ts";

const PROVIDER_ENV_NAMES = [
  "PI_CLAUDE_CODE_COMMAND",
  "PI_CLAUDE_CODE_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
  POWERSHELL_ENV,
] as const;

async function providerEnvironment(ctx: AuthContext): Promise<ProviderEnv | undefined> {
  const env: ProviderEnv = {};
  await Promise.all(
    PROVIDER_ENV_NAMES.map(async (name) => {
      const value = await ctx.env(name);
      if (value !== undefined) env[name] = value;
    }),
  );
  return Object.keys(env).length ? env : undefined;
}

// Pi resolves provider-scoped settings (such as PI_CLAUDE_CODE_COMMAND) only
// through auth hooks. Remember the latest values so model discovery and the
// status command look at the same Claude Code installation as requests do.
let lastProviderEnv: ProviderEnv | undefined;

/** The environment used to locate and configure Claude Code. */
export function claudeCodeEnv(): Record<string, string | undefined> {
  return { ...process.env, ...lastProviderEnv };
}

/**
 * OpenBuild: one Claude Code login. Each profile is its own provider (`claude-code`,
 * `claude-code-2`, …) with its config directory and executable pinned, so discovery, auth checks
 * and requests never cross accounts and never depend on process.env.
 */
export interface ClaudeCodeProfile {
  id?: string;
  name?: string;
  configDir?: string;
  command?: string;
}

export function createClaudeCodeProvider(profile: ClaudeCodeProfile = {}) {
  const id = profile.id ?? PROVIDER_ID;
  const pinnedEnv: ProviderEnv = {
    ...(profile.configDir ? { PI_CLAUDE_CODE_CONFIG_DIR: profile.configDir, CLAUDE_CONFIG_DIR: profile.configDir } : {}),
    ...(profile.command ? { PI_CLAUDE_CODE_COMMAND: profile.command } : {}),
  };
  const pinned = Object.keys(pinnedEnv).length > 0;
  // Per-instance state: a profile never reads another profile's environment.
  let profileEnv: ProviderEnv | undefined;
  const environment = () => (pinned ? { ...process.env, ...profileEnv, ...pinnedEnv } : claudeCodeEnv());
  const resolveEnvironment = async (ctx: AuthContext) => {
    const resolved = await providerEnvironment(ctx);
    if (!pinned) lastProviderEnv = resolved;
    profileEnv = pinned ? { ...resolved, ...pinnedEnv } : resolved;
    return profileEnv;
  };
  const profileModel = <T extends { provider: string }>(model: T): T => ({ ...model, provider: id });
  const stream: typeof streamClaudeCode = pinned
    ? (model, context, options) => streamClaudeCode(model, context, { ...options, env: { ...profileEnv, ...options?.env, ...pinnedEnv } })
    : streamClaudeCode;
  let discoveredIds: Set<string> | undefined;
  // OpenBuild: the last check that found the login. Pi checks again on every model refresh and hides
  // the provider's models when a check comes back empty, until the next one: a status check that
  // failed to run says nothing about the login, so that one keeps this answer.
  let lastReady: { type: "oauth" | "api_key"; source: string } | undefined;
  const externalOAuthMarker = () => ({
    type: "oauth" as const,
    access: "claude-code-external",
    refresh: "claude-code-external",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  });
  return createProvider({
    id,
    name: profile.name ?? "Claude Code Subscription (Experimental)",
    baseUrl: "process://claude-code",
    auth: {
      apiKey: {
        name: "Claude Code login",
        // Report the external Claude Code subscription as OAuth-shaped auth so
        // Pi can label list-price accounting as "(sub)". Requests still resolve
        // through this ambient method; credentials remain owned by Claude Code.
        async check({ ctx, signal }) {
          await resolveEnvironment(ctx);
          const status = await getClaudeStatus(environment(), signal);
          // Only report the provider as configured when Claude Code is
          // installed and logged in, so Pi hides its models otherwise.
          if (status.available && status.loggedIn) {
            return (lastReady = {
              type: status.subscription ? "oauth" : "api_key",
              source: status.subscription ? `Claude Code ${status.plan ?? "subscription"}` : "Claude Code CLI",
            });
          }
          if (status.diagnostic && lastReady) return lastReady;
          lastReady = undefined;
          return undefined;
        },
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          const providerEnv = await resolveEnvironment(ctx);
          return {
            auth: { apiKey: "external-process" },
            env: providerEnv,
            source: "Claude Code CLI",
          };
        },
      },
      // Metadata marker for Pi's subscription-aware UI. This is deliberately
      // not the request auth path and never imports Claude Code credentials.
      // Login and logout are handled by the Claude Code CLI itself.
      oauth: {
        name: "Claude Code subscription (managed by Claude Code)",
        isSubscription: true,
        async login() {
          throw new Error(
            "Claude Code manages its own login. Run `claude auth login` in a terminal instead; " +
              "this provider uses it automatically.",
          );
        },
        async refresh(_credential, signal) {
          const status = await getClaudeStatus(environment(), signal);
          if (!status.subscription) throw new Error(status.detail ?? LOGIN_HINT);
          return externalOAuthMarker();
        },
        async toAuth() {
          return { apiKey: "external-process" };
        },
      },
    },
    models: CLAUDE_CODE_MODELS.map(profileModel),
    async fetchModels({ signal }) {
      const models = (await discoverClaudeModels(environment(), signal)).map(modelFromDiscovery).map(profileModel);
      discoveredIds = new Set(models.map((model) => model.id));
      return models;
    },
    filterModels(models) {
      const ids = discoveredIds;
      return ids ? models.filter((model) => ids.has(model.id)) : models;
    },
    api: {
      stream,
      streamSimple: stream,
    },
  });
}

export { API_ID, PROVIDER_ID };
