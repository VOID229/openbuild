#!/bin/sh
# macOS/Linux installer. Safe to pipe to either sh or bash.
# Everything runs from main, on the last line, so a truncated download does nothing.
# Pass --dry-run to play the installer without checking, downloading or changing anything:
#   curl -fsSL <url> | sh -s -- --dry-run
set -eu

steps='Checking requirements|Finding the latest release|Downloading OpenBuild|Installing dependencies|Linking the ob command'
ui_height=15
ui_pid=
tmp=
log=
fancy=0
background=dark
cloned=0
install_dir=
current=1
detail=

die() {
  [ -z "$ui_pid" ] || stop_ui fail
  printf 'openbuild: %s\n' "$*" >&2
  [ -z "$log" ] || [ ! -s "$log" ] || tail -n 20 "$log" >&2
  exit 1
}

cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ -n "$ui_pid" ]; then
    kill "$ui_pid" 2>/dev/null || true
    printf '\033[?2026l\033[0m\033[?25h\033[%dB\n' "$ui_height"
  fi
  [ -z "$tmp" ] || rm -rf "$tmp"
  if [ "$code" -ne 0 ] && [ "$cloned" -eq 1 ]; then
    cd / && rm -rf "$install_dir"
  fi
  exit "$code"
}

# Terminals answer OSC 11 with their background colour; the wordmark fades from it.
detect_background() {
  saved=$(stty -g </dev/tty) || return 0
  stty -echo -icanon min 0 time 2 </dev/tty
  printf '\033]11;?\033\\' >/dev/tty
  reply=$(dd bs=64 count=1 </dev/tty 2>/dev/null | tr -d '\033\007\\') || reply=
  stty "$saved" </dev/tty
  case $reply in *rgb:*/*/*) ;; *) return 0 ;; esac
  rgb=${reply#*rgb:}
  red=${rgb%%/*}; rgb=${rgb#*/}
  green=${rgb%%/*}; blue=${rgb#*/}
  red=$(printf %.1s "$red"); green=$(printf %.1s "$green"); blue=$(printf %.1s "$blue")
  case $red$green$blue in *[!0-9a-fA-F]*|'') return 0 ;; esac
  [ $((0x$red + 0x$green + 0x$blue)) -lt 24 ] || background=light
}

# Animate only for a colour, UTF-8 terminal that fits the wordmark. Anything else gets plain lines.
detect_ui() {
  [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ -z "${CI:-}" ] || return 0
  case ${LC_ALL:-${LC_CTYPE:-${LANG:-}}} in *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;; *) return 0 ;; esac
  case ${COLORTERM:-} in
    truecolor|24bit) colors=24 ;;
    *) case ${TERM:-dumb} in *256color*) colors=8 ;; *) return 0 ;; esac ;;
  esac
  size=$(stty size </dev/tty 2>/dev/null) || return 0
  [ "${size#* }" -ge 73 ] && [ "${size%% *}" -ge $((ui_height + 2)) ] || return 0
  sleep 0.01 2>/dev/null || return 0
  detect_background
  fancy=1
}

set_state() {
  [ "$fancy" -eq 1 ] || return 0
  printf '%s\n' "$1" >"$tmp/state.next"
  mv "$tmp/state.next" "$tmp/state"
}

step() {
  current=$1
  detail=${2-}
  set_state "$current|run|$detail"
  [ "$fancy" -eq 1 ] || printf '%s\n' "$(printf '%s' "$steps" | cut -d'|' -f"$current")"
}

run() {
  "$@" </dev/null >>"$log" 2>&1
}

start_ui() {
  [ "$fancy" -eq 1 ] || return 0
  set_state '1|run|'
  awk -v state="$tmp/state" -v labels="$steps" -v height="$ui_height" -v colors="$colors" -v background="$background" '
    function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v }
    function smooth(v) { v = clamp(v); return v * v * (3 - 2 * v) }
    function ease(v) { v = 1 - clamp(v); return 1 - v * v * v }
    function shade(q) { return q >= levels - 1 ? "\033[39m" : ramp[q] }
    function level(x, r,   d, head, reveal, rest, band, gap, value) {
      d = x + (rows - r) * 1.6
      head = ease(frame / intro) * (span + edge)
      reveal = smooth((head - d) / edge)
      rest = 1 - 0.45 * smooth((frame - intro) / 24)
      gap = (d - (-glow + (span + 2 * glow) * ((frame % period) / period))) / glow
      band = smooth(1 - (gap < 0 ? -gap : gap))
      value = reveal * (rest + (1 - rest) * band)
      if (outro >= 0) {
        band = smooth((ease(outro / outro_length) * (span + edge) - d) / edge)
        value = value + (1 - value) * band
      }
      return value
    }
    function draw(   out, r, x, q, last, i, c, alpha, mark, text, tone) {
      out = "\033[?2026h\n"
      for (r = 1; r <= rows; r++) {
        out = out "  "; last = -1
        for (x = 1; x <= span; x++) {
          c = cell[r, x]
          if (c == "") { out = out " "; continue }
          q = final ? levels - 1 : int(level(x, r) * (levels - 1) + 0.5)
          if (q < 1) { out = out " "; continue }
          if (q != last) { out = out shade(q); last = q }
          out = out c
        }
        out = out "\033[0m\033[K\n"
      }
      out = out "\n"
      for (i = 1; i <= count; i++) {
        alpha = smooth((frame - intro * 0.45 - i * 3) / 10)
        if (i < current || status == "done") { mark = "\033[32m\342\234\223"; tone = 0.62 }
        else if (i == current && status == "fail") { mark = "\033[31m\342\234\227"; tone = 1 }
        else if (i == current) { mark = spinner[int(frame / 3) % 10 + 1]; tone = 1 }
        else { mark = "\302\267"; tone = 0.35 }
        text = label[i]
        if (i == 2 && detail != "") text = text "  " detail
        if (alpha < 1) mark = "\302\267"
        out = out "  " shade(int(alpha * tone * (levels - 1) + 0.5)) mark "\033[0m " shade(int(alpha * tone * (levels - 1) + 0.5)) text "\033[0m\033[K\n"
      }
      out = out "\033[K"
      if (!final) out = out "\033[" (height - 1) "A\r"
      else out = out "\n"
      printf "%s\033[?2026l", out
      fflush()
    }
    function read_state(   line, part) {
      if ((getline line < state) > 0) {
        split(line, part, "|")
        current = part[1] + 0; status = part[2]; detail = part[3]
      }
      close(state)
    }
    BEGIN {
      levels = 48; intro = 42; outro = -1; outro_length = 26
      edge = 18; glow = 20; period = 96
      count = split(labels, label, "|")
      split("\342\240\213 \342\240\231 \342\240\271 \342\240\270 \342\240\274 \342\240\264 \342\240\246 \342\240\247 \342\240\207 \342\240\217", spinner, " ")
      split("\342\226\230 \342\226\235 \342\226\200 \342\226\226 \342\226\214 \342\226\236 \342\226\233 \342\226\227 \342\226\232 \342\226\220 \342\226\234 \342\226\204 \342\226\231 \342\226\237 \342\226\210", glyph, " ")
      rows = split(".8ceffc4.............................ffffdc4..........af5.af.......ed 8f7...3fd..cc.cc4....8ccc...cc.cc4...f5...ff..cc...c4.8c..af...8cc4ff ff.....af4.ff333fd.8f733bf4.ff333fd..fdcccf1..ff...ff.af5.af..ef333ff ff.....ef1.ff...af5affffff5.ff...ff..f7..3bf4.ff...ff.af5.af..f5...ff 2fdcccef3..ffc.8ff.2fd4.cc4.ff...ff..fdcccef1.bf4.cff.af5.af..bf4.cff ..33333....ff2333....33331..33...33..333333....333133.231.23...333133 ...........ff........................................................", line_of, " ")
      for (r = 1; r <= rows; r++) {
        span = length(line_of[r])
        for (x = 1; x <= span; x++) {
          value = index("123456789abcdef", substr(line_of[r], x, 1))
          cell[r, x] = value ? glyph[value] : ""
        }
      }
      from = background == "light" ? 232 : 34
      to = background == "light" ? 24 : 240
      for (q = 0; q < levels; q++) {
        gray = int(from + (to - from) * q / (levels - 1))
        if (colors == 24) ramp[q] = "\033[38;2;" gray ";" gray ";" gray "m"
        else ramp[q] = "\033[38;5;" (232 + int((gray - 8) / 10.1)) "m"
      }
      for (i = 0; i < height; i++) printf "\n"
      printf "\033[%dA\033[?25l", height
      while (1) {
        read_state()
        if (status == "fail") break
        if (status == "done" && frame >= intro && outro < 0) outro = 0
        if (outro > outro_length) break
        draw()
        frame++
        if (outro >= 0) outro++
        system("sleep 0.033")
      }
      final = 1
      draw()
      printf "\033[?25h"
    }
  ' </dev/null &
  ui_pid=$!
}

stop_ui() {
  [ -n "$ui_pid" ] || return 0
  set_state "$current|$1|$detail"
  wait "$ui_pid" || true
  ui_pid=
}

pause() {
  [ "$fancy" -eq 0 ] || sleep "$1"
}

dry_run() {
  step 1; pause 0.9
  step 2; pause 1
  step 3 v0.0.0; pause 1.8
  step 4 v0.0.0; pause 2.4
  step 5 v0.0.0; pause 0.8
}

install() {
  step 1
  command -v git >/dev/null 2>&1 || die 'Install Git first.'
  command -v bun >/dev/null 2>&1 || die 'Install Bun 1.3.8 or newer first: https://bun.sh/docs/installation'
  bun -e 'const [a,b,c] = Bun.version.split(".").map(Number); process.exit(a > 1 || (a === 1 && (b > 3 || (b === 3 && c >= 8))) ? 0 : 1)' </dev/null || die 'Bun 1.3.8 or newer is required.'
  [ ! -e "$install_dir" ] && [ ! -L "$install_dir" ] || die "Installation path already exists: $install_dir. Use the existing checkout or choose OPENBUILD_INSTALL_DIR."
  mkdir -p "$(dirname "$install_dir")"

  step 2
  release_tag=$(bun -e '
    const response = await fetch("https://api.github.com/repos/VOID229/openbuild/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "OpenBuild" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const release = await response.json();
    if (release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(release.tag_name)) throw new Error("Invalid stable release tag");
    console.log(release.tag_name);
  ' </dev/null 2>>"$log") || die 'Could not find a published stable release. Check your connection or install from source.'

  step 3 "$release_tag"
  cloned=1
  run git clone --branch "$release_tag" -- https://github.com/VOID229/openbuild.git "$install_dir" || die 'Could not download OpenBuild.'
  cd "$install_dir"
  pwd -P >.git/openbuild-installed

  step 4 "$release_tag"
  run bun install --frozen-lockfile || die 'Could not install dependencies.'

  step 5 "$release_tag"
  run bun run cli:install || die 'Could not link the ob command.'
}

main() {
  dry=0
  for arg in "$@"; do
    case $arg in
      --dry-run) dry=1 ;;
      *) die "Unknown option: $arg" ;;
    esac
  done
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) die 'This installer supports macOS and Linux.' ;;
  esac

  install_dir=${OPENBUILD_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/openbuild/app}
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 129' HUP
  trap 'exit 143' TERM
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/openbuild.XXXXXX")
  log=$tmp/log
  : >"$log"
  detect_ui
  start_ui

  if [ "$dry" -eq 1 ]; then dry_run; else install; fi
  stop_ui done
  cloned=0

  if [ "$dry" -eq 1 ]; then
    printf 'Dry run: nothing was checked, downloaded or changed.\n'
    return
  fi
  printf 'OpenBuild installed in %s\n' "$install_dir"
  printf 'Ensure %s/bin is on PATH, then run:\n\n  ob password\n  ob start\n' "${BUN_INSTALL:-$HOME/.bun}"
}

main "$@"
