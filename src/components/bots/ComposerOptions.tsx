// The line under a bot's chat box: the model it runs on, in the box's muted words, opening the same
// list as its details' Advanced tab and saved the same way (PATCH /api/bots/:id), so a new model
// takes from the bot's next turn. Only in a direct chat with one of the user's own bots: a group
// has several models, and a friend's bot runs on theirs.
import { useBots } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { BotModelSelect } from "./BotAdvanced";

export function ComposerOptions({ bot }: { bot: Bot }) {
  const defaultModel = useBots((s) => s.defaultModel);
  return (
    <div className="bots-opts" role="group" aria-label={`${bot.name.split(" ·")[0]}'s model`}>
      <BotModelSelect label="Model" compact value={bot.model} unset="Default" inherited={defaultModel} onChange={(model) => useBots.getState().updateBot(bot.id, { model })} />
    </div>
  );
}
