// One-time setup of the hosted sync service that every copy of OpenChat signs in to:
//
//   bun run setup:cloud
//
// 1. Logs you in to Convex (free) and creates the project, if that hasn't happened yet.
// 2. Deploys convex/ to the project's production deployment.
// 3. Generates the key pair Convex Auth signs sessions with and stores it on the deployment
//    (only the public half is ever published; the private key goes straight to Convex).
// 4. Writes the deployment's address to shared/cloud.ts. Commit that file, and everyone running
//    this repo gets Settings → Account with sign-up and sign-in, nothing to set up.
//
// Safe to re-run (to deploy changes in convex/): existing signing keys are kept.
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const CLOUD_FILE = join(root, "shared", "cloud.ts");

// Called by `convex deploy --cmd` with the production URL in the environment.
if (process.argv.includes("--write-url")) {
  const url = process.env.OPENCHAT_CLOUD_URL;
  if (!url) throw new Error("No deployment URL");
  const source = await Bun.file(CLOUD_FILE).text();
  await Bun.write(CLOUD_FILE, source.replace(/export const CLOUD_URL = ".*";/, `export const CLOUD_URL = ${JSON.stringify(url)};`));
  process.exit(0);
}

async function run(args: string[], quiet = false): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bunx", "convex", ...args], {
    cwd: root,
    stdin: quiet ? "ignore" : "inherit",
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  });
  const out = quiet ? await new Response(proc.stdout as ReadableStream).text() : "";
  return { code: await proc.exited, out: out.trim() };
}

async function must(args: string[], what: string) {
  if ((await run(args)).code !== 0) {
    console.error(`\n✖ ${what} failed. Fix the problem above and run \`bun run setup:cloud\` again.`);
    process.exit(1);
  }
}

console.log("\n1/3  Convex project");
if (!process.env.CONVEX_DEPLOYMENT) await must(["dev", "--once"], "Creating the Convex project");
else console.log("     Already set up.");

console.log("\n2/3  Deploying the sync service");
await must(["deploy", "--cmd", "bun scripts/setup-cloud.ts --write-url", "--cmd-url-env-var-name", "OPENCHAT_CLOUD_URL"], "Deploying");

console.log("\n3/3  Sign-in keys");
const existing = await run(["env", "get", "--prod", "JWKS"], true);
if (existing.code === 0 && existing.out.startsWith("{")) {
  console.log("     Already set; keeping them (replacing them would sign everyone out).");
} else {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateKey = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, " ");
  const jwks = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] });
  await must(["env", "set", "--prod", "JWT_PRIVATE_KEY", "--", privateKey], "Saving the signing key");
  await must(["env", "set", "--prod", "JWKS", "--", jwks], "Saving the public key");
  await must(["env", "set", "--prod", "SITE_URL", "--", "http://localhost:3000"], "Saving SITE_URL");
}

const url = (await Bun.file(CLOUD_FILE).text()).match(/CLOUD_URL = "(.*)"/)?.[1];
console.log(`\n✔ Accounts are live at ${url}`);
console.log("  Restart `bun run dev`, then Settings → Account → Create an account.");
console.log("  Commit shared/cloud.ts so every copy of OpenChat uses it.\n");
