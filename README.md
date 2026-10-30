# OpenBuild

OpenBuild is the bigger brother of [OpenChat](https://openchat.shade-io.com)

it's meant to be self hosted on localhost, LAN or Tailscale and used freely with your preferences.

OpenBuild is free and self-hosted. Your chosen agents, model providers, and search services receive the requests you send them and may charge for usage.

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

It will ask for device name, LAN or Tailscale, then show a code.
Put that code in the client pair after choosing the same connection type.

OpenBuild works with your existing coding agents like [Pi](https://pi.dev), [Codex](https://developers.openai.com/codex), [Claude Code](https://code.claude.com), [Cursor](https://cursor.com), [OpenCode](https://opencode.ai), and [Fx](https://fx.sh) with your paid Subs or connected API keys.

OpenBuild isn't selling anything, collecting any data or offering any compute.

## installation

Supports macOS and Linux. Requires Git and Bun 1.3.8 or newer on PATH (see [Bun installation](https://bun.sh/docs/installation)). The installer installs the latest published stable GitHub release into `~/.local/share/openbuild/app` and links `openbuild` and `ob` into Bun's bin directory. It refuses to overwrite an existing installation.

#### *looks nice*

```
curl -fsSL https://shade-io.com/openbuild/install.sh | sh
```
#### *if you have trust issues*

```
curl -fsSL https://raw.githubusercontent.com/VOID229/openbuild/main/install.sh | bash
```

After installation, open a new terminal if needed, then run:

```sh
ob password
ob start
```

A local password is required before starting. Install or connect your preferred coding agent from Settings.

#### *Or*

```
git clone https://github.com/VOID229/openbuild # clone the repo
cd openbuild
bun install
bun link
```

## Updates

```sh
ob update                      # install the latest release on your track
ob --set-track stable          # default: published regular releases
ob --set-track nightly         # published prereleases
ob restart                     # use the installed update
```

Track selection is saved per machine. OpenBuild checks GitHub releases at most hourly while the app is open, and after CLI start/restart/status commands. The app shows an update notice under Settings → Notifications → New Builds. Offline checks never prevent startup. Nightly follows prereleases, not every commit to main.

User plugins are kept in the data directory outside the application checkout; app updates never replace them or their settings. Existing checkout plugins are copied there once at startup without overwriting user folders. An explicit `pluginsDir` remains supported; use a folder outside the checkout.

Updates require a clean Git checkout and preserve local branches and commits. They install a release tag and its frozen dependencies; they never reset local edits. Running agents continue until you explicitly restart. Switching tracks can install an older release from the other track. A track with no published releases reports that there is nothing to install.

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

## License

OpenBuild is licensed under the [MIT License](LICENSE). This license applies to the entire project, including all prior commits and revisions.
