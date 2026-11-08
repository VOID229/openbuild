# Bots' machines

Every bot reaches every machine at once: this server, and each paired device whose owner allows
this server's bots. There's no single computer to choose per bot.

## Tools take a machine per call

`bash`, `read`, `write`, `edit`, `browser` and `process` take an optional `machine`: a name or id
from the bot's context. Without one they run on this server. `send_message` takes `machine` too, for
its `images` and `attach_screenshot`.

A bot has a computer of its own on each machine: its own home folder, files, processes and browser.
`where.txt` on this server and `where.txt` on a laptop are different files. A process's exit is only
announced for processes on this server; on another machine the bot checks with `process read`.

A link to a file in a message is `file:///path` on this server, or `file://<machine id>/path` on a
paired device.

## Nothing falls back

A call goes to the machine it names or fails, saying why; it never runs somewhere else instead.

- An unknown or unpaired machine: `"X" isn't this server or a machine paired with it`, with the list.
- A device that hasn't allowed this server's bots, or not that tool: the device's own refusal, with
  where its owner allows it.
- A device that's offline, revoked the pairing, or whose address now answers as another machine:
  the matching error. Nothing ran.

Requests to a paired device go to `/api/computers/to/<server id>/…`, which only that device runs, so
a moved address never runs anything.

## Who decides what

| Setting | Where | Who |
| --- | --- | --- |
| Whether this server's bots may use a device, per tool (Files, Terminal, Browser) and Unisolated | That device's Settings → Devices → Using this device | The device's owner. Pairing alone allows nothing. |
| Isolation on each machine (Container or Host) | This server's Settings → Devices, on each device's row | The user. A container where unset. Host on a paired device also needs its Unisolated grant. |

Settings → Bots (and the Advanced tab in OpenBots) shows the machines read-only: whether each allows
bots, what with, and why not. Each one opens that device in Settings → Devices.

The bot's context lists the machines with the same status on every turn. `manage_bot computers`
returns them for any bot (`id`, `name`, `status`, `tools`, `isolation`).

## Older saved choices

Bots used to have one computer (`computer: { device, kind }`, set with `runs_on` and `isolation`).
That value is kept in the bot's data as it was and no longer read: tools default to this server, and
isolation comes from the machine. Files on the computer it used stay where they were and are reached
by naming that machine. `manage_bot` refuses `runs_on` and `isolation` with an explanation, and
changes nothing.
