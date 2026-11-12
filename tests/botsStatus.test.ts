import { expect, test } from "bun:test";
import openbots from "../server/bots/extension";

test("every work tool requires a custom status and preserves its own required parameters", () => {
  const tools: any[] = [];
  openbots({ on() {}, registerTool(tool: any) { tools.push(tool); } });
  // Tools that put something in the chat (or its to-do list) show as that, not as a status line, and load_tools and jobs are over at once.
  const exempt = new Set(["send_message", "react", "question", "poll", "html_render", "todo", "load_tools", "jobs"]);
  expect(tools.length).toBeGreaterThan(20);
  for (const tool of tools) {
    if (exempt.has(tool.name)) {
      expect(tool.parameters.properties.status).toBeUndefined();
      expect(tool.parameters.required).not.toContain("status");
    } else {
      expect(tool.parameters.required).toContain("status");
      expect(tool.parameters.properties.status.minLength).toBe(1);
      expect(tool.parameters.properties.status.description).toContain("specific call");
    }
  }
  expect(tools.find(t => t.name === "bash").parameters.required).toEqual(["command", "status"]);
  expect(tools.find(t => t.name === "use_app").parameters.required).toEqual(["app", "tool", "status"]);
  expect(tools.find(t => t.name === "html_render").parameters.required).toEqual(["html", "title"]);
  expect(tools.find(t => t.name === "todo").parameters.required).toEqual(["action"]);
});
