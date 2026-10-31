#!/bin/sh
# Nightly entry point; share the main installer and forward its options.
set -eu

main() {
  installer=$(mktemp "${TMPDIR:-/tmp}/openbuild-nightly.XXXXXX")
  trap 'rm -f "$installer"' EXIT
  trap 'exit 130' INT
  trap 'exit 129' HUP
  trap 'exit 143' TERM
  curl -fsSL https://raw.githubusercontent.com/VOID229/openbuild/main/install.sh -o "$installer"
  sh "$installer" --nightly "$@"
}

main "$@"
