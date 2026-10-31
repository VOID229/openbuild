import { resolve } from "node:path";

const docs = resolve(import.meta.dir, "../docs/plugins.md");

export const PLUGIN_GUIDANCE_NOTE = `[OpenBuild plugin instructions: When asked to create or modify plugins, use the conversation and current project to identify which plugin system the user means, checking whether the project has its own plugins. Proceed when clear; otherwise ask which system they mean. For OpenBuild plugins, read ${JSON.stringify(docs)} first for the plugin API, examples, and installation location.]\n\n`;
