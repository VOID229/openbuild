#!/usr/bin/env bash
# Prints the nightly tag for a commit: scripts/nightly-tag.sh <commit> <run-number>
#
# A nightly is a prerelease of the version it's heading to: the patch after the highest stable tag
# in the commit's history. After stable 0.1.8 the nightlies are 0.1.9-nightly.<date>.<run>, which
# semver sorts above 0.1.8 and below the 0.1.9 they become.
set -euo pipefail

commit=${1:?commit}
run=${2:?run number}

stable=$(git tag --merged "$commit" --sort=-version:refname \
  | awk '/^v?[0-9]+\.[0-9]+\.[0-9]+$/ && !found { print; found=1 }')
if [[ -z "$stable" ]]; then
  echo "No stable version tag found in this commit's history." >&2
  exit 1
fi
[[ "$stable" =~ ^(v?[0-9]+\.[0-9]+\.)([0-9]+)$ ]]
base="${BASH_REMATCH[1]}$((10#${BASH_REMATCH[2]} + 1))"
date=$(git show -s --format=%cs "$commit" | tr -d '-')
echo "${base}-nightly.${date}.${run}"
