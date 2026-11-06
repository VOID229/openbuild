// The app's GitHub settings: which credential is in use, connecting the GitHub App with the device
// flow, where it's installed, and disconnecting. A device sign-in belongs to the browser that started
// it: a cookie only that browser holds, together with its session, has to come with every look at it
// or cancel. The device code and every token stay on the server; the browser sees the user code.
import { createHash, randomBytes } from "node:crypto";
import { bad } from "../handlers";
import * as apps from "../bots/apps";
import * as github from "./auth";

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

const FLOW_COOKIE = "openbuild_github_flow";
const SESSION_COOKIE = "openbuild_session";

const json = (value: unknown, status = 200, headers?: HeadersInit) => {
  const res = Response.json(value, { status, headers });
  res.headers.set("cache-control", "no-store");
  return res;
};
const fail = (err: unknown) => {
  if (err instanceof github.GithubError) return bad(err.message, err.status);
  console.error("[github]", err instanceof Error ? err.message : err);
  return bad("Something went wrong", 500);
};

/** A cookie's value, only when the request carries exactly one of that name. */
function cookie(req: Request, name: string): string | undefined {
  const found = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  return found.length === 1 ? found[0]!.slice(name.length + 1) : undefined;
}

/** Who a device sign-in belongs to: this browser's flow cookie and its session, hashed. */
export const flowOwner = (secret: string, session: string | undefined) => createHash("sha256").update(`${secret}\n${session ?? ""}`).digest("hex");

function ownerOf(req: Request): string {
  const secret = cookie(req, FLOW_COOKIE);
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new github.GithubError("That sign-in was started somewhere else.", 403);
  return flowOwner(secret, cookie(req, SESSION_COOKIE));
}

let listening = false;

export function githubRoutes(api: Api) {
  // The bots' GitHub app reconnects with whatever credential is now in use.
  if (!listening) {
    github.onGithubChange(apps.githubChanged);
    listening = true;
  }
  return {
    "/api/github": {
      GET: api(async () => {
        try {
          return json(await github.view());
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/github/installations": {
      GET: api(async () => {
        try {
          return json({ installations: await github.installations() });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/github/device": {
      POST: api(async (req: Request) => {
        try {
          const secret = randomBytes(32).toString("hex");
          const started = await github.startDevice(flowOwner(secret, cookie(req, SESSION_COOKIE)));
          const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
          return json(started, 200, { "set-cookie": `${FLOW_COOKIE}=${secret}; Path=/api/github/device; HttpOnly; SameSite=Strict; Max-Age=1200${secure}` });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/github/device/:id": {
      GET: api(async (req: Bun.BunRequest<"/api/github/device/:id">) => {
        try {
          return json(github.deviceStatus(req.params.id, ownerOf(req)));
        } catch (err) {
          return fail(err);
        }
      }),
      DELETE: api((req: Bun.BunRequest<"/api/github/device/:id">) => {
        try {
          github.cancelDevice(req.params.id, ownerOf(req));
          return json({ ok: true });
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/github/disconnect": {
      POST: api(async () => {
        try {
          await github.disconnect();
          return json(await github.view());
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/github/use-pat": {
      POST: api(async () => {
        try {
          await github.usePat();
          return json(await github.view());
        } catch (err) {
          return fail(err);
        }
      }),
    },
    "/api/github/revoke": {
      POST: api(async () => {
        try {
          await github.revokeLeaked();
          return json(await github.view());
        } catch (err) {
          return fail(err);
        }
      }),
    },
  };
}
