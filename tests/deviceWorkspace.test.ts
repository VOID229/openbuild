import { describe, expect, test } from "bun:test";
import type { Project } from "../shared/types";
import { chooseDevice, chooseProject, workspaceDevice } from "../src/lib/devices";
import type { Chat, NewWorkspace } from "../src/lib/types";

const project = (id: string, deviceId?: string, extra: Partial<Project> = {}): Project => ({ id: deviceId ? `${deviceId}::${id}` : id, name: id, path: `/${id}`, git: true, deviceId, ...extra });
const thread = (updatedAt: number, projectId: string, deviceId?: string) => ({ updatedAt, workspace: { projectId, projectName: projectId, cwd: "/x", deviceId } }) as Chat;
const base: NewWorkspace = { mode: "local" };
const projects = [project("here"), project("one", "mac"), project("two", "mac")];

describe("switching the new-thread device", () => {
  test("returns to the project last chosen on that device", () => {
    const onMac = chooseProject(base, "mac::two");
    const back = chooseDevice(onMac, undefined, projects, []);
    expect(back.projectId).toBe("here");
    expect(chooseDevice(back, "mac", projects, []).projectId).toBe("mac::two");
  });

  test("a device that last used its scratch folder goes back to it, even with projects", () => {
    const scratch = chooseProject(chooseProject(base, "mac::two"));
    expect(workspaceDevice(scratch)).toBe("mac");
    const back = chooseDevice(chooseDevice(scratch, undefined, projects, []), "mac", projects, []);
    expect(back.projectId).toBeUndefined();
    expect(workspaceDevice(back)).toBe("mac");
  });

  test("without a remembered choice, follows the device's latest thread", () => {
    expect(chooseDevice(base, "mac", projects, [thread(1, "one", "mac"), thread(2, "two", "mac"), thread(3, "here")]).projectId).toBe("mac::two");
    expect(chooseDevice(base, "mac", projects, [thread(1, "two", "mac"), thread(2, "", "mac")]).projectId).toBeUndefined();
  });

  test("a device with no projects gets its scratch folder", () => {
    const next = chooseDevice(chooseProject(base, "here"), "new", projects, []);
    expect(next.projectId).toBeUndefined();
    expect(next.deviceId).toBe("new");
  });

  test("a project used but never chosen here falls back past removed and missing ones", () => {
    const list = [project("gone", "mac", { missing: true }), project("one", "mac")];
    expect(chooseDevice({ ...base, lastProjects: { mac: "mac::removed" } }, "mac", list, [thread(2, "removed", "mac")]).projectId).toBe("mac::one");
  });
});
