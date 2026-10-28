// /api/usage: tokens and cost across the agents on this machine and paired devices;
// /api/usage/limits: their plans' limits. `scope=local` (what devices ask each other) is this machine only.
import { USAGE_RANGES, type UsageRange } from "../../shared/usage";
import { limits } from "./limits";
import { machineLimits, machineReports, mergeReports } from "./machines";
import { report } from "./report";

type Wrap = <R extends Request>(handler: (req: R) => Response | Promise<Response>) => (req: R) => Response | Promise<Response>;

const fail = (err: unknown) => Response.json({ error: (err as Error).message || "Usage couldn't be read" }, { status: 500 });

export function usageRoutes(api: Wrap) {
  return {
    "/api/usage": {
      GET: api(async (req) => {
        const url = new URL(req.url);
        const p = url.searchParams;
        const range = USAGE_RANGES.includes(p.get("range") as UsageRange) ? (p.get("range") as UsageRange) : "30d";
        const tz = (p.get("tz") ?? "UTC").slice(0, 64);
        const force = p.has("fresh");
        try {
          const local = () => report(range, tz, force);
          if (p.get("scope") === "local") return Response.json(await local());
          const { machines, reports } = await machineReports(range, tz, force, local);
          // `machine`: one machine's numbers ("local" or a device id); otherwise all of them added up.
          const pick = p.get("machine");
          const chosen = pick && pick !== "all" ? reports.filter((r) => r.machine.id === pick) : reports;
          const merged = chosen.length ? mergeReports(chosen) : { ...(await local()), providers: [], series: [], models: [], days: [] };
          return Response.json({ ...merged, machines });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/usage/limits": {
      GET: api(async (req) => {
        const p = new URL(req.url).searchParams;
        const force = p.has("fresh");
        try {
          if (p.get("scope") === "local") return Response.json({ providers: await limits(force), checkedAt: Date.now() });
          return Response.json(await machineLimits(force, () => limits(force)));
        } catch (err) {
          return fail(err);
        }
      }),
    },
  };
}
