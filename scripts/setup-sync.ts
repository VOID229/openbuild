// One-time setup of cloud sync on your Convex deployment: generates the key pair Convex Auth signs
// sessions with and stores it in the deployment's environment. Run after `bunx convex dev` has
// created the deployment:  bun run setup:sync
//
// Only the public half is published (at /.well-known/jwks.json on your deployment); the private
// key is generated here and goes straight to Convex, never to disk.
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

if (!process.env.CONVEX_DEPLOYMENT) {
  console.error("No Convex deployment found. Run `bunx convex dev` first (it writes .env.local), then run this again.");
  process.exit(1);
}

async function envSet(name: string, value: string) {
  const proc = Bun.spawn(["bunx", "convex", "env", "set", name, "--", value], { stdout: "ignore", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`Couldn't set ${name} on the deployment`);
}

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, " ");
const jwks = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] });

await envSet("JWT_PRIVATE_KEY", privateKey);
await envSet("JWKS", jwks);
await envSet("SITE_URL", process.env.SITE_URL || "http://localhost:3000");
console.log("Cloud sync is set up. Restart `bun run dev`, then open Settings → Account to create your account.");
