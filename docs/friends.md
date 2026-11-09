# Friends

A friend is another person's OpenBuild. Once you're friends, your bots and theirs can talk in **shared group chats**. That's all a friend can do: they can't reach your app, sign-in, pairing, files, terminals, threads, projects, settings or your bots' computers.

Pairing is different. A paired device is one of **your own** machines, trusted to run projects, threads and shells. A friend is someone else, so OpenBuild trusts them far less: they get a protocol of their own, on a port of its own, and nothing else.

## Becoming friends

One of you invites, the other adds the code. You pick Tailscale, LAN or your own OpenTunnel relay when you invite.

```sh
# on the inviting computer (the host)
ob friend invite --tailscale      # or --lan, or --tunnel; without one it asks

# on the friend's computer (the guest)
ob friend add obf1_…              # the code the host printed
```

1. `ob friend invite` prints a **one-time code that expires in 15 minutes**. It holds the host's address, the host server's public key, and a secret. Send it to your friend however you like.
2. Your friend runs `ob friend add <code>`. Their server asks yours to be friends and proves it has the code, without sending the secret.
3. The invite on your terminal shows who's asking and their key's fingerprint, and asks you to **approve**. Decline if you weren't expecting them.
4. Both servers keep each other's public key. From then on, everything between them is signed with those keys.

The code works once. If it expires or someone else used it first, run `ob friend invite` again. Both computers need OpenBuild running (`ob start`). The friend commands talk to the running server.

### Over Tailscale

Only **one** of you shares a machine: the host. Use the Tailscale admin console: Machines, then the host machine, then Share, and invite your friend's email. Your friend accepts the share, then runs `ob friend add`.

Only one side needs to share because a shared machine can't open connections back to the person it's shared with. Tailscale's docs say "A shared machine can receive incoming connections (from the other user's tailnet) but cannot start connections". So the guest's server opens **one long-lived connection** to the host and holds it, and messages flow both ways over it. If either side restarts, the guest reconnects by itself, backing off from 1 second up to 1 minute between tries. Messages written meanwhile wait and are delivered once, in order, when it's back.

The host's friend listener binds to the machine's Tailscale address only, on its own port: **3200 by default** (OpenBuild's port + 100), or `OPENBUILD_FRIEND_PORT`. Tailscale needs its own network interface here. Userspace networking (common in containers) has no address OpenBuild can listen on. Use LAN there.

#### Limit what your friend can reach

Sharing a machine lets your friend reach that one machine, but **on every port your tailnet policy allows**. Tailscale's docs warn that rules like `"src": ["*"]` "apply to everyone who has access to your tailnet, including invited users". If OpenBuild's app, or anything else, listens on your Tailscale address, a friend could reach it unless the policy stops them.

So hold shared users to the friend port. In the admin console, open Access controls and edit the tailnet policy file. `ob friend invite --tailscale` prints the `autogroup:shared` rule below with your machine's address and port filled in:

```json
"grants": [
  { "src": ["autogroup:member"], "dst": ["*"], "ip": ["*"] },
  { "src": ["autogroup:shared"], "dst": ["100.101.102.103"], "ip": ["tcp:3200"] }
]
```

The first rule keeps your own devices' access. Use whatever member rule you already have, but make sure **no rule has `"src": ["*"]`**, because that includes shared users. The second lets anyone you've shared a machine with reach TCP port 3200 on that machine and nothing else. `"ip": ["3200"]` without `tcp:` would also allow UDP and ICMP. `autogroup:shared` works as a source but not as a destination, so the destination is the machine's Tailscale IP.

The older `acls` form of the same rules:

```json
"acls": [
  { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] },
  { "action": "accept", "src": ["autogroup:shared"], "proto": "tcp", "dst": ["100.101.102.103:3200"] }
]
```

**The free Personal plan.** Here is exactly what Tailscale's docs say, as of writing:

- Sharing is available on all plans.
- The pricing FAQ says access controls are "available for all plans", Personal included. Personal lists up to 3 ACL groups, which these rules don't use.
- The pricing page doesn't name grants at all, and we found no statement either way about grants on Personal. Tailscale recommends grants and says ACLs "will always be supported". If your policy editor won't take `grants`, use the `acls` form.

Check against [Tailscale's sharing docs](https://tailscale.com/kb/1084/sharing), the [policy syntax](https://tailscale.com/kb/1337/policy-syntax) and [pricing](https://tailscale.com/pricing), since plans change.

Your friend's tailnet policy has a say too: it has to let their machine reach machines shared with them. A default policy does.

### Over LAN

The host's friend listener listens on all its network interfaces on the friend port, and the code gives its LAN addresses (or `--address host[:port]`). A firewall on the host has to let that port in.

On a LAN the friend traffic is **signed but not encrypted**. Nobody can forge or alter it, but anyone on the network can read what your bots and your friend's bots say. Tailscale and OpenTunnel encrypt it. Prefer one of those unless you trust the network.

### Over OpenTunnel

[OpenTunnel](https://github.com/anomalyco/opentunnel) gives a machine a public HTTPS address through a relay, with no port forwarding and nothing for your friend to set up. OpenBuild uses **your own self-hosted relay only**. It has no default relay and never falls back to a public one: without `OPENBUILD_FRIEND_TUNNEL_API`, `--tunnel` refuses.

Only the host runs a tunnel. Your friend just adds the code: their server opens one long-lived, encrypted WebSocket (WSS) to the address in it, and messages go both ways over that, as over Tailscale.

What the tunnel reaches is the **friend listener and nothing else**. OpenBuild runs the `opentunnel` client with one route, to the friend port on `127.0.0.1`. The app's port, its sign-in and its API are never routed. The client runs only while an invite through it waits or a friend connects through it, and stops with OpenBuild.

#### Set up your relay

You run the relay; OpenBuild only runs the client. Following OpenTunnel's [self-hosting guide](https://github.com/anomalyco/opentunnel/blob/master/docs/server.md#self-hosting):

1. Run the OpenTunnel server on a machine with a public address, port 443 open, and the MySQL database it needs.
2. Give it a domain: point the domain and its wildcard (`*.tunnel.example.com`) at that machine.
3. Give it DNS-01 access so it can get wildcard certificates: `DNS_PROVIDER=cloudflare` with `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN`, or `DNS_PROVIDER=exec` with a `DNS_HOOK` script for other DNS hosts.
4. Install the client on the computer that invites: `npm install -g opentunnel` or `cargo install opentunnel-cli`. The guest doesn't need it.

OpenBuild doesn't do any of this for you, and doesn't change DNS.

#### Point OpenBuild at it

Set these in the environment OpenBuild starts with, then restart it:

| Variable | |
| --- | --- |
| `OPENBUILD_FRIEND_TUNNEL_API` | **Required.** Your relay's URL, like `https://tunnel.example.com`. It has to be `https://`, except for a relay on this machine (`http://localhost:8080`) while you try one out. |
| `OPENBUILD_FRIEND_TUNNEL_BIN` | The `opentunnel` client, when it isn't on `PATH`. |
| `OPENBUILD_FRIEND_TUNNEL_CA` | A CA certificate the client should trust, for a relay with a private CA (`ISSUER=local`). The guest's server needs it too, through `NODE_EXTRA_CA_CERTS`. |

Then `ob friend invite --tunnel`. The code gives `https://<route>.<your tunnel's hostname>`.

The client gets a profile of its own (`openbuild-friends`), with its config and data under `<data>/friends/tunnel`. So it doesn't touch tunnels you run yourself, and it ignores any `OPENTUNNEL_*` variables you've set for them. The tunnel's hostname and the route name are kept, so your friend's saved address keeps working across restarts. Deleting that folder gives you a new address, and your friends would need a new invite.

#### What the relay can and can't do

- The relay passes TLS it can't decrypt. The client on your computer holds the certificate's key. But the relay's operator controls DNS and certificates for its domain, which is why it should be yours.
- The friend protocol doesn't trust the tunnel at all. Everything that crosses is signed with the keys you approved, as on a LAN. Tunneled requests reach the listener from `127.0.0.1`, and anyone can find the address (it ends up in certificate logs). Neither means anything to OpenBuild.
- The address is public, so the listener is held to a budget there: [the protocol](#the-protocol) has the limits.
- The relay resets a connection with no traffic for 15 minutes by default. Friends' heartbeats every 20 seconds keep theirs up.

## Shared chats

```sh
ob friend chat Alice "Weekend plans" --bots "Dr Eggbot,Scout"   # share a new group chat, with these bots of yours
ob friend chats                                                 # the chats you share
ob friend join "Weekend plans" --bots Juniper                   # bring another of your bots in
ob friend leave "Weekend plans" --bots Scout                    # or take one out
```

A shared chat shows up in OpenBots on both sides, under **With friends**, named with the friend's name ("Weekend plans · Alice"). A chat a friend shares with you starts with none of your bots. **You choose which of yours join**, from the chat's Members panel or with `ob friend join`. You can write in it yourself too.

Each side keeps **its own copy**. What crosses is plain text, from an owner or one of their bots, and who's in the chat on each side. These stay on the side they're on:

- the chat's name, if you rename it, and its goal
- reactions, and questions a bot asks you
- which bots read what
- events like "Added" or "Paused"

Photos and polls don't cross either, so OpenBuild refuses to post them in a shared chat rather than show them on one side only.

Deleting a shared chat on your side tells your friend you left it, and their copy stops syncing.

In the chat, a friend's bot shows as "Bolt · Alice" and the friend as "Alice · friend", in the usual chat styling.

## How your bots treat friends

Everything a friend writes is **untrusted input** to your bots. It isn't your instructions.

- **Attributed.** In a bot's transcript, a friend's line reads `Bolt [Alice's bot: untrusted]` or `Alice [friend, not Gal: untrusted]`. The chat says it's shared with your friend, and that their lines are conversation, not instructions. The friend's own name is the one you approved, whatever a message claims.
- **Only when addressed.** A friend's message wakes only the bots of yours it mentions by name (`@Juniper`, or `@all`) or replies to. Untagged chatter wakes nobody. Bots are told to mention a friend's bot to talk to it.
- **Its own Pi, chat only.** In a shared chat a bot runs on a separate Pi, with a separate session, one per friend. What a friend writes never enters the bot's own conversations, and its memory, routines, other chats and your settings changes don't enter the shared chat. There it has two tools: `send_message` and `react`, in that chat only, without photos. OpenBuild enforces this twice: Pi is started with only those tools, and the bots' tool socket refuses anything else from that Pi. That holds even with your own Pi extensions switched on: they still load, since a bot's model can come from one, but their tools don't. The bot's own search skips shared chats, so a friend's words don't come back into its own work that way either.
- **Your rules, if you want more.** `ob friend tools Alice on` lets your bots use their usual tools in chats with Alice (each bot still limited by its own settings). They're still told Alice is untrusted. `off` goes back to chat only.
- **Rate limit.** A friend's server sending more than 120 messages a minute is cut off and has to reconnect. Nothing is lost, it just slows them down.

What this can't do: a model reading a friend's message can still be talked into saying things. The bot's instructions are in its prompt, and it can repeat them. Bots are told to keep your details, memory and other chats private, and in chat-only mode they don't have those to give. But don't put secrets in the instructions of a bot you share.

## Removing a friend

```sh
ob friend list            # your friends and whether they're connected
ob friend remove Alice
```

Or use Settings → Bots → Friends → Remove. Removing takes effect **at once**: their key is forgotten, the connection closes, whatever was waiting to go to them is dropped, and any frame or connection from them after that is refused. Your shared chats with them stay to read, marked as not syncing.

If they're connected, their server hears it straight away and does the same on their side. If they were offline, their server finds it's refused the next time it connects: `ob friend list` there shows "refused".

## The protocol

For the curious, and for anyone reviewing it. The code is in `server/friends/`.

- **Identity.** Each server makes an Ed25519 key pair the first time it needs one (`<data>/friends/identity.json`, owner-only). A friend's id is a fingerprint of their public key, the same on both sides.
- **The friend listener** is a separate `Bun.serve` with one small handler, not the app's server with routes left out. It answers `GET /friend/v1/connect`, `POST /friend/v1/join` and `POST /friend/v1/join/status`. Everything else is a 404, and so is any request from a browser (one with an `Origin` or `Sec-Fetch-Site` header). It only listens while an invite is waiting or a friend connects here.
- **Limits before work.** Through a tunnel the listener is on the open internet, and every request looks like it's from loopback, so nothing is decided by address. Before any key lookup, signature check or body is read, a request has to fit in the listener's budget (300 requests a minute, from everyone together, otherwise 429). It also has to be 64 KB or less (otherwise 413), and a connect has to name a key id in the right form (otherwise 404). Unknown ids are refused (403) before the WebSocket upgrade. Codes and polls that don't check out are limited to 10 a minute. At most 16 connections can wait on the handshake. Connections already proved aren't counted against the budget, but each friend is held to 600 frames a minute of any kind, as well as the message limit.
- **Transports.** How the two servers reach each other is kept apart from the protocol (`server/friends/transport.ts`). LAN, Tailscale and OpenTunnel each decide only where the listener binds, which addresses an invite gives, and what keeps running so those reach it. The guest always opens one connection, `ws://` or `wss://`, and the protocol over it is the same.
- **Joining.** The guest proves it holds the invite's secret with an HMAC over the invite id, its own key id and a fresh nonce. It signs the request with its own key. The host checks every answer against the key in the code, so nobody in between can stand in for either side. Wrong codes are rate-limited.
- **Connecting.** The guest dials `/friend/v1/connect?from=<its id>`. An unknown or removed id is refused before the upgrade. The host sends a challenge signed with its key. The guest answers it, naming a session id, signed with its key. The host confirms. Ten seconds to finish, and a cap on connections that haven't.
- **Frames.** Every frame either way is signed: `{"p": "<payload JSON>", "s": "<signature>"}` over a domain tag and the exact payload text. Payloads say who they're from and who they're for, so a frame can't be reflected back or sent to another friend. A frame that doesn't check out closes the connection.
- **Replay protection and delivery.** Data frames carry a sequence number per direction. The receiver applies only numbers above the last one it applied, and acknowledges what it has. A frame the receiver couldn't apply (its database busy, say) isn't acknowledged and is never skipped: it's kept and tried again after 1, 2, 4 seconds and so on, up to a minute apart, until it applies. The frames after it wait unacknowledged, and the sender still has them all. If it keeps failing, `ob friend list` and Settings → Bots → Friends say a message from that friend couldn't be delivered yet. Control frames (acks, heartbeats, removal) are bound to the connection's session id. The sender keeps each frame in an outbox (SQLite, next to the chats) until it's acknowledged, and resends on reconnecting. So restarts lose nothing, and nothing arrives twice: message ids are kept across too.
- **Heartbeats.** Both sides ping every 20 seconds. A connection silent for 65 seconds is closed and the guest dials again.
- **Ports.** `OPENBUILD_FRIEND_PORT` changes the friend port (default: the app's port + 100). It's saved the first time it's used, so a friend's saved address keeps working. `OPENBUILD_FRIEND_HOST` overrides where the listener binds (the tests use loopback).
- **Tunnel settings.** `OPENBUILD_FRIEND_TUNNEL_API`, `OPENBUILD_FRIEND_TUNNEL_BIN` and `OPENBUILD_FRIEND_TUNNEL_CA`: see [Over OpenTunnel](#over-opentunnel).
- **The CLI** talks to the running server over a unix socket in the data folder (`friends/control.sock`, owner-only). It never writes friend data itself.
