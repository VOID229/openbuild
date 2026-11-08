// The models bots can run on, as a component sees them: asked for once, then replaced by each fresh
// listing, which comes whenever the custom extensions change (see onBotModels).
import { useEffect, useState } from "react";
import { botModels, onBotModels, type PiModels } from "../pi";

/** The bots' listing, or undefined while it's asked for and when Pi can't start with these extensions (`failed`). */
export function useBotModels(): { listing?: PiModels; failed: boolean } {
  const [state, setState] = useState<{ listing?: PiModels; failed: boolean }>({ failed: false });
  useEffect(() => {
    // The latest listing wins: a fresh one, after the extensions changed, replaces whatever came before.
    let asked = 0;
    const take = (listing: Promise<PiModels>) => {
      const mine = ++asked;
      void listing.then(
        (r) => mine === asked && setState({ listing: r, failed: false }),
        () => mine === asked && setState({ failed: true }),
      );
    };
    take(botModels());
    const stop = onBotModels(take);
    return () => {
      asked = -1;
      stop();
    };
  }, []);
  return state;
}
