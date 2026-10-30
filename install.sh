#!/bin/sh
# macOS/Linux installer. Safe to pipe to either sh or bash.
set -eu

die() { printf 'openbuild: %s\n' "$*" >&2; exit 1; }
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die 'This installer supports macOS and Linux.' ;;
esac
command -v git >/dev/null 2>&1 || die 'Install Git first.'
command -v bun >/dev/null 2>&1 || die 'Install Bun 1.3.8 or newer first: https://bun.sh/docs/installation'
bun -e 'const [a,b,c] = Bun.version.split(".").map(Number); process.exit(a > 1 || (a === 1 && (b > 3 || (b === 3 && c >= 8))) ? 0 : 1)' || die 'Bun 1.3.8 or newer is required.'

install_dir=${OPENBUILD_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/openbuild/app}
[ ! -e "$install_dir" ] && [ ! -L "$install_dir" ] || die "Installation path already exists: $install_dir. Use the existing checkout or choose OPENBUILD_INSTALL_DIR."
mkdir -p "$(dirname "$install_dir")"
release_tag=$(bun -e '
  const response = await fetch("https://api.github.com/repos/VOID229/openbuild/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "OpenBuild" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(release.tag_name)) throw new Error("Invalid stable release tag");
  console.log(release.tag_name);
') || die 'Could not find a published stable release. Check your connection or install from source.'
git clone --branch "$release_tag" -- https://github.com/VOID229/openbuild.git "$install_dir"
cd "$install_dir"
bun install --frozen-lockfile
bun run cli:install

printf '\nOpenBuild installed in %s\n' "$install_dir"
printf 'Ensure %s/bin is on PATH, then run:\n\n  ob password\n  ob start\n' "${BUN_INSTALL:-$HOME/.bun}"
