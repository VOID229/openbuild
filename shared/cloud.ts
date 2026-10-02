// The hosted sync service every copy of OpenChat signs in to (a Convex production deployment).
// Written once by `bun run setup:cloud`. Empty means accounts aren't available yet.
// It's a public address, not a secret: everything stored there is encrypted on the device first.
export const CLOUD_URL = "https://shocking-bandicoot-943.convex.cloud";
