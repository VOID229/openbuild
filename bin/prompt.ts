import { createInterface } from "node:readline/promises";

/** A CLI question must release the terminal, including on the first Ctrl+C. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const cancel = () => {
    // Bun 1.3.8 closes readline on Ctrl+C but leaves question() pending.
    // Handle readline's SIGINT explicitly rather than waiting for a second signal.
    rl.close();
    process.stdin.pause();
    process.stdout.write("\n");
    process.exit(130);
  };
  rl.once("SIGINT", cancel);
  let onClose: () => void;
  try {
    // EOF closes readline without settling question() on some supported runtimes.
    // It must not look like Enter accepting a confirmation's default.
    const closed = new Promise<never>((_, reject) => {
      onClose = () => reject(new Error("Input closed before an answer was entered."));
      rl.once("close", onClose);
    });
    return (await Promise.race([rl.question(question), closed])).trim();
  } finally {
    rl.removeListener("close", onClose!);
    rl.removeListener("SIGINT", cancel);
    rl.close();
    process.stdin.pause();
  }
}

/** Enter accepts the displayed default. */
export async function confirm(question: string, fallback = true): Promise<boolean> {
  const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return answer ? answer === "y" || answer === "yes" : fallback;
}
