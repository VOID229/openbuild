/** Share worker/discovery work across tabs and polls. Startup may read saved chats while it runs. */
export function createChatRefresh(refresh: () => Promise<void>, onError: (error: unknown) => void) {
  let pending: Promise<void> | undefined;
  return async (maxWait?: number): Promise<void> => {
    const work = pending ??= Promise.resolve().then(refresh).catch(onError).finally(() => { pending = undefined; });
    if (maxWait === undefined) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWait); })]);
    } finally {
      clearTimeout(timer);
    }
  };
}
