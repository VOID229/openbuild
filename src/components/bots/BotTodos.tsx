// A conversation's to-do list: the steps of the work going on in a chat, which its bots keep with
// their todo tool. Read-only here: it shows where the work stands, and only the bots change it. It
// sits in the details panel (a group's Goal tab, a bot's Tasks tab), and its progress shows in the
// chat's header.
import { Check } from "lucide-react";
import { todoProgress } from "../../../shared/bots";
import { useBots } from "../../lib/bots/store";
import type { Bot, Conversation, TodoItem } from "../../lib/bots/types";
import { openBotsDetails } from "../../lib/gestures";
import { cx } from "../../lib/ui";
import { BotAvatar } from "./BotAvatar";

const STATUS_LABEL = { todo: "To do", doing: "In progress", done: "Done" } as const;

/** How far along the list is: "3/7" over a thin bar. */
function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div className="bots-todos-bar" role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <span style={{ transform: `scaleX(${total ? done / total : 0})` }} />
    </div>
  );
}

function Row({ item, conversation, bots }: { item: TodoItem; conversation: Conversation; bots: Bot[] }) {
  const bot = conversation.kind === "group" && item.bot && item.status !== "todo" ? bots.find((b) => b.id === item.bot) : undefined;
  const done = item.status === "done";
  return (
    <li className={cx("bots-todo", `bots-todo-${item.status}`)}>
      <span className="bots-todo-check" role="img" aria-label={STATUS_LABEL[item.status]} data-status={item.status}>
        {done && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="bots-todo-text">{item.text}</span>
      {bot && (
        <span className="bots-todo-bot" data-tooltip={`${bot.name.split(" ·")[0]} ${done ? "did this" : "is on it"}`} data-tooltip-side="left">
          <BotAvatar look={bot.look} size={16} alive={false} />
        </span>
      )}
    </li>
  );
}

export function TodoList({ conversation, bots }: { conversation: Conversation; bots: Bot[] }) {
  const items = conversation.todos ?? [];
  const { done, total } = todoProgress(items);
  return (
    <section className="bots-todos" aria-label="Tasks">
      <div className="bots-todos-head">
        <span className="bots-todos-label">Tasks</span>
        {total > 0 && (
          <span className="bots-todos-count" aria-label={`${done} of ${total} done`}>
            {done}/{total}
          </span>
        )}
      </div>
      {total > 0 && <Progress done={done} total={total} />}
      {total > 0 ? (
        <ul className="bots-todos-list">
          {items.map((item) => (
            <Row key={item.id} item={item} conversation={conversation} bots={bots} />
          ))}
        </ul>
      ) : (
        <p className="bots-todos-empty">No tasks yet. Bots add them as they work.</p>
      )}
    </section>
  );
}

/** A small ring and "3/7" in the chat's header while it has a to-do list. A click opens the list. */
export function HeadTasks({ conversation, mobile }: { conversation: Conversation; mobile: boolean }) {
  const { done, total } = todoProgress(conversation.todos);
  if (!total) return null;
  const r = 5.25;
  const around = 2 * Math.PI * r;
  return (
    <span
      className={cx("bots-head-tasks", done === total && "bots-head-tasks-done")}
      role="button"
      tabIndex={-1}
      aria-label={`Tasks: ${done} of ${total} done`}
      data-tooltip="Tasks"
      onClick={(e) => {
        e.stopPropagation();
        if (mobile) openBotsDetails();
        useBots.getState().showDetailsTab("tasks");
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle className="bots-head-tasks-track" cx="7" cy="7" r={r} />
        <circle className="bots-head-tasks-fill" cx="7" cy="7" r={r} strokeDasharray={`${(done / total) * around} ${around}`} transform="rotate(-90 7 7)" />
      </svg>
      {done}/{total}
    </span>
  );
}
