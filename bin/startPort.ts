import { createServer } from "node:net";

/** Probe without contacting, signalling, or adopting the listener. */
export async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function chooseStartPort(port: number, options: {
  explicit: boolean;
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  available?: (port: number) => Promise<boolean>;
}): Promise<number> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  const available = options.available ?? portAvailable;
  if (await available(port)) return port;
  const message = `Port ${port} is already in use. The existing listener was left running.`;
  if (options.explicit || !options.interactive)
    throw new Error(`${message} Choose a free port with PORT=<port> ob start${options.explicit ? "." : ", or run ob start in a terminal to choose an alternative."}`);
  for (let alternative = port + 1; alternative <= 65535; alternative++) {
    if (!(await available(alternative))) continue;
    if (!(await options.confirm(`${message} Start OpenBuild on port ${alternative}?`)))
      throw new Error("Start cancelled. The existing listener was left running.");
    // Another process may have bound the candidate while the prompt was open.
    if (await available(alternative)) return alternative;
  }
  throw new Error("No free alternative port found. Choose one with PORT=<port> ob start.");
}
