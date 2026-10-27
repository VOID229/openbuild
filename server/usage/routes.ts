// /api/usage: tokens and cost across the agents on this machine; /api/usage/limits: their plans' limits.
import { USAGE_RANGES, type UsageRange } from "../../shared/usage";
import { limits } from "./limits";
import { report } from "./report";

type Wrap = <R extends Request>(handler: (req: R) => Response | Promise<Response>) => (req: R) => Response | Promise<Response>;

const fail = (err: unknown) => Response.json({ error: (err as Error).message || "Usage couldn't be read" }, { status: 500 });

export function usageRoutes(api: Wrap) {
  return {
    "/api/usage": {
      GET: api(async (req) => {
        const url = new URL(req.url);
        const range = url.searchParams.get("range") as UsageRange;
        const tz = (url.searchParams.get("tz") ?? "UTC").slice(0, 64);
        try {
          return Response.json(await report(USAGE_RANGES.includes(range) ? range : "30d", tz, url.searchParams.has("fresh")));
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/usage/limits": {
      GET: api(async (req) => {
        try {
          return Response.json({ providers: await limits(new URL(req.url).searchParams.has("fresh")), checkedAt: Date.now() });
        } catch (err) {
          return fail(err);
        }
      }),
    },
  };
}
