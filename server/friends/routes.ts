// The app's view of friends: who they are and whether they're connected, and removing one. Adding
// friends and sharing chats is the CLI's (`openbuild friend`). A paired device's token never reaches
// these (devicePathAllowed in server/index.ts): friends are this machine's owner's to manage.
import { bad } from "../handlers";
import { remove, summaries } from "./manage";

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

export function friendRoutes(api: Api) {
  return {
    "/api/friends": {
      GET: api(() => Response.json({ friends: summaries() })),
    },
    "/api/friends/:id": {
      DELETE: api((req: Bun.BunRequest<"/api/friends/:id">) => (remove(req.params.id) ? Response.json({ ok: true }) : bad("No such friend", 404))),
    },
  };
}
