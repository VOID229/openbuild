import { defineExtension } from "@earendil-works/pi-durable";
import { type BashToolInput, createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
export const MAX_BASH_TIMEOUT_SECONDS = 600;

/** Keep a forgotten timer or browser event from parking a Durable turn forever. */
export function durableCodingTools(defaultTimeout = DEFAULT_BASH_TIMEOUT_SECONDS) {
  if (!Number.isFinite(defaultTimeout) || defaultTimeout <= 0 || defaultTimeout > MAX_BASH_TIMEOUT_SECONDS) {
    throw new Error("Invalid Durable bash timeout");
  }
  const bash = createBashTool();
  return defineExtension({
    name: "coding-tools",
    tools: [createReadTool(), createWriteTool(), createEditTool(), {
      ...bash,
      description: `${bash.description} Defaults to ${defaultTimeout} seconds; maximum ${MAX_BASH_TIMEOUT_SECONDS} seconds. Run persistent servers as background jobs with redirected stdio, not foreground commands.`,
      parameters: {
        ...bash.parameters,
        properties: {
          ...bash.parameters.properties,
          timeout: { ...bash.parameters.properties.timeout, description: `Timeout in seconds (default ${defaultTimeout}, maximum ${MAX_BASH_TIMEOUT_SECONDS})` },
        },
      },
      execute(args: BashToolInput, api, context) {
        // Leave invalid values to upstream validation rather than silently accepting them.
        const timeout = args.timeout === undefined ? defaultTimeout
          : Number.isFinite(args.timeout) ? Math.min(args.timeout, MAX_BASH_TIMEOUT_SECONDS) : args.timeout;
        return bash.execute({ ...args, timeout }, api, context);
      },
    }],
  });
}
