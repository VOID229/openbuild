# Bot work status

The primary bot can call `manage_bot` with `action: "status"` to read metadata for
all bots. The service checks the caller's current primary flag on every request,
including authenticated tool dispatch; being primary when a token was issued does
not preserve access after demotion. Other bots cannot read this projection.

Each entry contains `id`, `name`, `state` (working or idle), `runnerState`
(including error, and waiting), `turnStartedAt`, `conversationId`, `lastActivityAt`,
`backgroundJobs`, and `pendingAssignments`. A bot between turns whose tool calls are
still running in the background (see `docs/openbots-async-jobs.md`) is idle: it's free
to take a message. Its `runnerState` is `waiting` and `backgroundJobs` counts them. Times are Unix milliseconds; unknown times and the current
conversation of an idle bot are null. Working state comes from the same
runner-published service status used by the sidebar, including quiet work. It is
not inferred from a running process. Turn start stays fixed across activity
updates. Last activity means the last runner status update, including completion
or error, not the last human message or a claim of progress. These timestamps
are in-memory observations; they can be unknown after server startup.

Pending assignments contain only conversation ids and exact user-message ids
from runner deliveries queued or in the current turn (including accepted scoped
steers). They are delivery references, not proof that a request is unanswered:
a bot can already have replied while finishing its turn. They disappear when
the delivery completes, and are not a durable task ledger across restarts.
`handoffs` lists what one bot has asked another in a group, by @mention or by
quoting it, that isn't settled yet: `conversationId`, `from`, `to`, `messageId`
and `at`. This ledger is kept in the database and survives restarts. An entry
goes once the asked bot is done and the asker has its answer (it is woken to read
what the other wrote there, named or not), once the asked bot has read the
message and written nothing, or once the asker has been told it went unread for
10 minutes. Conversational promises and handoffs made in plain words, with no
mention, are not classified. Empty lists do not prove that all conversational
obligations are resolved.

The result excludes message bodies, prompts, activity text, error details,
credentials, computer configuration and model calls. This action changes no
bot settings and wakes no bots. It adds no UI or production configuration.
Application code requires the normal deployment/restart to become available;
implementing and testing it does not restart the production server.
