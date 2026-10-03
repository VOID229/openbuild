import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Composer drafts synced between devices only live a few minutes (shared/drafts.ts).
crons.interval("expire drafts", { minutes: 10 }, internal.sync.expireDrafts, {});

export default crons;
