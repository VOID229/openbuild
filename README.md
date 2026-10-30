# OpenBuild

OpenBuild is the bigger brother of [OpenChat](openchat.shade-io.com)

it's meant to be self hosted on localhost, LAN or Tailscale and used freely with your preferences.

nothing costs money, nothing gets your data, it's yours.

```
## basic
ob start # start the openbuild server
ob restart # restart the openbuild server
ob stop # stop the openbuild server, agents keep working
ob stop --all # stop the openbuild server and all agents
```

OpenBuild supports remote devices, you don't need to have multiple instances of its website running on each machine and opened in different browser tabs.

it runs a headless OpenBuild server on the remote machine and connects to it over LAN or Tailscale

```
## pairing
ob pair --host # pair this machine for a client to use remotely
ob pair --client # pair a remote host to use in the openbuild server
```

It will ask for device name, LAN or Tailscale then show a code.
Put that code in the client pair after choosing the same connection type.

OpenBuild works with your existing coding agents like [Pi](pi.dev), [Codex](developers.openai.com/codex), [Claude Code](code.claude.com), [Cursor](cursor.com), [OpenCode](opencode.ai), and [Fx](fx.sh) with your paid Subs or connected API keys.

OpenBuild isn't selling anything, collecting any data or offering any compute.

## installation

#### *looks nice*

```
curl -fsSL https://shade-io.com/openbuild/install.sh | sh
```
#### *if you have trust issues*

```
curl -fsSL https://raw.githubusercontent.com/VOID229/openbuild/main/install.sh | bash
```

#### *Or*

```
git clone https://github.com/VOID229/openbuild # clone the repo
cd openbuild
bun install
bun link
```

## Security

being extra careful is always worth it, set a password to protect your machines

```
ob password # must be 4 or more characters
```

Upon setting the password, the website will ask for it in order to start
using OpenBuild, so that not anything that can reach the URL has access
to run agents on your device.

You wont need to enter the password on each page reload or server restart.
your browser stores an random token cookie and the server verifies its hash to keep you logged in. it auto expires after 30 days of idle.
