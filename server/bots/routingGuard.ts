// Loaded last, after selected account/model extensions. No OpenBots socket or tools.
export default function (pi: any) {
  pi.on("session_start", () => pi.setActiveTools([]));
  pi.on("before_agent_start", () => pi.setActiveTools([]));
  pi.on("tool_call", () => ({ block: true, reason: "Routing cannot use tools." }));
}
