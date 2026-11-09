// A conversation's to-do list: the steps of the work going on in a chat, which its bots keep with
// their todo tool and the user ticks off, adds to or trims here. It sits in the details panel (a
// group's Goal tab, a bot's Tasks tab), and its progress shows in the chat's header.
import { Check, Plus, X } from "lucide-react";
import { useState } from "react";
import { todoProgress } from "../../../shared/bots";
import { useBots } from "../../lib/bots/store";
import type { Bot, Conversation, TodoItem } from "../../lib/bots/types";
import { openBotsDetails } from "../../lib/gestures";
import { cx } from "../../lib/ui";
import { IconButton } from "../primitives";
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
  const st = useBots.getState();
  const bot = conversation.kind === "group" && item.bot && item.status !== "todo" ? bots.find((b) => b.id === item.bot) : undefined;
  const done = item.status === "done";
  return (
    <li className={cx("bots-todo", `bots-todo-${item.status}`)}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done ? true : item.status === "doing" ? "mixed" : false}
        aria-label={`${item.text}: ${STATUS_LABEL[item.status]}`}
        className="bots-todo-check"
        onClick={() => st.editTodos(conversation.id, { action: "update", id: item.id, status: done ? "todo" : "done" })}
      >
        {done && <Check size={11} strokeWidth={3} />}
      </button>
      <span className="bots-todo-text">{item.text}</span>
      {bot && (
        <span className="bots-todo-bot" data-tooltip={`${bot.name.split(" ·")[0]} ${done ? "did this" : "is on it"}`} data-tooltip-side="left">
          <BotAvatar look={bot.look} size={16} alive={false} />
        </span>
      )}
      <IconButton label="Remove" tooltipSide="left" className="bots-todo-x" onClick={() => st.editTodos(conversation.id, { action: "remove", id: item.id })}>
        <X size={13} />
      </IconButton>
    </li>
  );
}

export function TodoList({ conversation, bots }: { conversation: Conversation; bots: Bot[] }) {
  const items = conversation.todos ?? [];
  const { done, total } = todoProgress(items);
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    useBots.getState().editTodos(conversation.id, { action: "add", items: [text] });
    setDraft("");
  };
  return (
    <section className="bots-todos" aria-label="Tasks">
      <div className="bots-todos-head">
        <span className="bots-todos-label">Tasks</span>
        {total > 0 && (
          <span className="bots-todos-count" aria-label={`${done} of ${total} done`}>
            {done}/{total}
          </span>
        )}
        {done > 0 && (
          <button type="button" className="bots-todos-clear" onClick={() => useBots.getState().editTodos(conversation.id, { action: "clear", which: "done" })}>
            Clear done
          </button>
        )}
      </div>
      {total > 0 && <Progress done={done} total={total} />}
      <ul className="bots-todos-list">
        {items.map((item) => (
          <Row key={item.id} item={item} conversation={conversation} bots={bots} />
        ))}
        <li className="bots-todo bots-todo-add">
          <span className="bots-todo-check bots-todo-plus" aria-hidden>
            <Plus size={12} />
          </span>
          <input
            className="bots-todo-input"
            value={draft}
            placeholder="Add a task"
            aria-label="Add a task"
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                add();
              }
              if (e.key === "Escape" && draft) {
                e.stopPropagation();
                setDraft("");
              }
            }}
          />
        </li>
      </ul>
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
