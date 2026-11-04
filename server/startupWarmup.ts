/** Run independent, read-only cache jobs before announcing readiness, with a hard startup budget. */
export async function warmCaches(jobs: Record<string, () => Promise<unknown>>, budgetMs = 8000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.allSettled(Object.entries(jobs).map(async ([name, job]) => {
    try { await job(); } catch (err) { console.warn(`[startup] ${name}: ${(err as Error).message}`); }
  }));
  try { await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, budgetMs); })]); }
  finally { clearTimeout(timer); }
}

export async function warmStartup(discoverThreads: () => Promise<unknown>) {
  // Test servers exercise adapters in isolation; an unrelated account probe must not escape a fixture.
  if (process.env.OPENBUILD_WARMUP === "0" || (process.env.NODE_ENV === "test" && process.env.OPENBUILD_WARMUP !== "1")) return;
  console.log("[startup] Preparing thread summaries, usage and limits…");
  const [{ report }, { limits }, { machineReports, machineLimits }, storage] = await Promise.all([
    import("./usage/report"), import("./usage/limits"), import("./usage/machines"), import("./storage"),
  ]);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  await warmCaches({
    "thread discovery": discoverThreads,
    "sidebar summaries": () => storage.chatSummaries(),
    "usage": () => machineReports("30d", zone, false, () => report("30d", zone)),
    "limits": () => machineLimits(false, () => limits()),
  });
  console.log("[startup] Cache warm-up finished; slow providers continue in the background.");
}
