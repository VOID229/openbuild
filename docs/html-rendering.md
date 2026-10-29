# In-thread HTML across runtimes

Pi exposes `html_render` and, when Chrome is installed, `html_preview` through its extension. Previously these tools were absent from every other runtime.

Codex, Claude Code, Cursor, fx, OpenCode and Durable now receive display instructions for a reserved `openbuild-html` Markdown fence containing a self-contained HTML page. The worker converts complete, validated blocks into ordinary `html_render` events before persistence. The existing sandbox, theme bootstrap, auto-height, download and fullscreen UI handle those events. Ordinary `html` fences and fenced examples remain source. Incomplete or rejected documents remain source too. This path does not expose Pi's screenshot preview tool to other runtimes.

Native workers advertise `html-delivery`; new native threads select a compatible worker generation. An idle existing thread whose owner predates `html-delivery` moves to a compatible lane on its next turn ([worker feature lanes](runtime-questions.md#worker-feature-lanes)); a pending turn is never moved.

## t3code comparison

Inspected the local t3code checkout at `/tmp/t3code`, particularly `apps/server/src/mcp/toolkits/html/{tools,handlers}.ts`. t3code provides `html_render` through its central MCP service, publishes a thread-scoped page reference, and returns that reference to the frontend. See [handlers](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/mcp/toolkits/html/handlers.ts).

OpenBuild currently has independent CLI/ACP/SDK adapters rather than a shared injected MCP service. The reserved output format gives all of them the same display capability without modifying native runtime configuration. It uses OpenBuild's existing event journal rather than adding a second artifact store. As with tool guidance, a model must follow the display instructions; source code is never automatically treated as executable HTML.
