// The production app (server/client.ts) built and served by a process of its own, as the server does
// (tests/productionClient.test.ts). Prints its URL once the build is done.
import { productionClient } from "../../server/client";

// Gone with the test: its stdin closes when the test's process ends, however that ends, and even
// while a build never finishes.
void (async () => {
  for await (const _ of Bun.stdin.stream());
  process.exit(0);
})();
const client = productionClient();
await client.built;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => client.serve(req) });
console.log(server.url.href);
