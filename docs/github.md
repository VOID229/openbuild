# GitHub sign-in

OpenBuild reaches GitHub for its page reader, app skills, the release check and the bots' GitHub
app. It does that with one credential the user chooses: the **OpenBuild GitHub App** (recommended)
or a **personal access token**. `gh` and `git` keep using the machine's own login; nothing here
changes them.

## Two different accounts

- **The app's developer account** registers the GitHub App once and owns its settings: its name,
  permissions and client ID. It can be a personal account or an organization; either works the same
  for users. An organization is the safer home when more than one person maintains the app. Ownership
  can be transferred later (the app's settings → Advanced → Transfer ownership).
- **Installation accounts** are wherever users install the app: their own personal account, or an
  organization. They pick the repositories there: all of them, or only selected ones. On an
  organization, an owner installs it or approves a member's request. Installing on organizations
  requires a public app.

A user's token reaches only what all three allow: the app's permissions, the user's own access, and
the repositories of installations they can use.

**OpenBuild doesn't choose between installations.** One token reaches every installation the user
can use, all at once. Apps → GitHub lists them, but that list doesn't limit anything. What limits bots
is GitHub's: each installation's repository selection and the user's own access. To keep bots out of
an account or a repository, uninstall the app there or take the repository out of its selection on
GitHub. Within what's reachable, OpenBuild's only rule is read-only (below).

## Registering the app (once, by its developer)

Register it under whichever account should own it:

- **A personal account:** Settings → Developer settings → GitHub Apps → New GitHub App.
- **An organization:** the organization's Settings → Developer settings → GitHub Apps → New GitHub
  App. This takes an organization owner, or a member the organization lets manage all its apps.

| Setting | Value |
| --- | --- |
| Homepage URL | The OpenBuild repository |
| Callback URL | Leave empty. Sign-in uses the device flow. |
| Request user authorization (OAuth) during installation | Off |
| Enable Device Flow | **On** |
| Expire user authorization tokens | **On**, the default. Tokens last 8 hours, refresh tokens 6 months. |
| Webhook → Active | **Off** |
| Repository permissions | Metadata: read (always). Contents: read & write. Issues: read & write. Pull requests: read & write. Actions: read. Checks: read. Commit statuses: read. |
| Account and organization permissions | None |
| Where can this app be installed? | **Any account**, so users can install it on their personal account and organizations |

Don't generate a private key: OpenBuild acts as the signed-in user, never as the app itself. Don't
generate or share a client secret either: the device flow and its token refresh don't use one.

Adding a permission later makes every installation approve it again, so keep the list short.

## Turning it on

Put the app's **client ID** (not the app ID) and its **slug** (from
`https://github.com/apps/<slug>`) in `GITHUB_APP` in `shared/github.ts`, so every install has them.
A server can use another app instead by setting `OPENBUILD_GITHUB_APP_CLIENT_ID` and
`OPENBUILD_GITHUB_APP_SLUG` and restarting. Both values are public.

Until a client ID is set, the GitHub app in Apps offers a personal access token only, as before.

## Connecting

1. Apps → GitHub → **Connect with GitHub**. OpenBuild shows a code. Enter it at GitHub's device
   page and approve OpenBuild there. The OpenBuild page carries on by itself.
2. **Install on my account** or **Install on an organization**, and pick the repositories on GitHub.
   Apps → GitHub lists every installation the user can reach (personal account or organization),
   with its repositories and a link to change them or uninstall it.
3. **What bots may do** starts at **Read only**. Choose **Read and write** and **Save** to let bots
   change things.

### Read-only is OpenBuild's rule

GitHub grants the app read and write. Read-only is enforced by OpenBuild on the server: before
every tool call, a bot's call runs only if GitHub's MCP server marks the tool read-only *and* its
name says it reads (`get_`, `list_`, `search_`, `_read`, with no write verb). A tool that's unknown,
unmarked or new counts as a write and is refused. OpenBuild also sends `X-MCP-Readonly: true`, but
that header isn't what keeps bots from writing.

## Which credential is used

The vault record `github-auth` holds the choice: `app`, `pat` or `off`. Only that credential is
used, and nothing falls back to another one.

- **An install from before this**, with no choice made, uses the saved personal access token, as
  before.
- **Pasting a token** into the GitHub app, or **Use my saved personal access token**, chooses the
  token.
- **Disconnecting** the GitHub App sets `off`. A token that's still saved stays saved, but nothing
  uses it until the user chooses it again.
- **The release check** reads public data. It also tries `GH_TOKEN`/`GITHUB_TOKEN` and `gh auth
  token`, as before. It never refreshes the app's token, because it runs from the CLI too.

Tokens live in the vault on the server: the OS keychain, or a 0600 file. They're never sent to the
browser or to bots, never listed, and never included in account key sync. Refreshes run one at a
time. The new pair is saved before it's used, and only if the credential hasn't changed meanwhile,
so a refresh that finishes after a disconnect can't bring it back.

A device sign-in belongs to the browser that started it: an HttpOnly cookie for that sign-in, plus
the browser's session. The device code stays on the server. Paired devices can't use these routes,
and the hosted site doesn't offer them.

## Disconnecting and revoking

- **Disconnect here** deletes OpenBuild's tokens from this server. GitHub still lists the
  authorization until the user revokes it at **Settings → Applications → Authorized GitHub Apps**.
  Only the user who authorized it can do that, and OpenBuild can't without the app's client secret.
  An organization owner can uninstall the app instead, which ends its access to that organization.
- **The token may have leaked** disconnects, then sends both tokens to GitHub's [credential
  revocation API](https://docs.github.com/en/rest/credentials/revoke). That API is meant for exposed
  credentials, takes no authentication, and GitHub notifies the user. That's why it isn't what a
  plain disconnect does.

## Before shipping: live checks

The tests run against a fake GitHub (`tests/fakeGithub.ts`). They don't stand in for these checks,
which need a real test app and an account with two private repositories, `sel` (selected for the
installation) and `unsel` (not selected):

| # | Check | Passes when |
| --- | --- | --- |
| G1 | Remote MCP `initialize` and `tools/list` at `api.githubcopilot.com/mcp/` with the app's user token | The session starts and lists tools |
| G2 | A harmless read of a file in private `sel` through an MCP tool | Returns the file |
| G3 | The same read on private `unsel` | Denied (404 or 403), nothing leaks |
| G4 | Refresh with the client ID only, on a device-flow token | New pair; the old access and refresh tokens are both refused |
| G5 | Read-only on, a bot calls a write tool | Refused by OpenBuild before any request reaches GitHub |
| G6 | Disconnect with a PAT still saved, and during a refresh | No credential is used; nothing comes back |
| G7 | Another browser or a paired device looks at or cancels the sign-in | 403; the device code never appears |

Record status codes and tool names only, never tokens or file contents. If G1–G3 fail on the remote
server, GitHub's local `github-mcp-server stdio` is a candidate, but it isn't assumed to work: it
has to pass G1–G3 itself.
