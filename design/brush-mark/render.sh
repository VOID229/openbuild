#!/usr/bin/env bash
# Renders 512px PNGs of the marks and the GitHub App icon, 512px-tall PNGs of the lockups, and the preview sheet, with headless Chromium.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
chrome="${CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1)}"
shot() { "$chrome" --headless=new --no-sandbox --hide-scrollbars --disable-gpu --force-device-scale-factor="${4:-1}" \
  --default-background-color=00000000 --virtual-time-budget=2000 \
  --window-size="$2" --screenshot="$3" "$1" >/dev/null 2>&1; }
mkdir -p "$dir/png" "$dir/screenshots"
for svg in "$dir"/svg/mark-*.svg "$dir"/svg/github-app-icon.svg; do shot "file://$svg" 512,512 "$dir/png/$(basename "${svg%.svg}").png"; done
for svg in "$dir"/svg/*-wordmark-*.svg; do
  read -r w h < <(grep -o 'width="[0-9]*" height="[0-9]*"' "$svg" | tr -dc '0-9 ' | awk '{print $1, $2}')
  shot "file://$svg" "$w,$h" "$dir/png/$(basename "${svg%.svg}").png" "$(awk "BEGIN{print 512/$h}")"
done
bun "$dir/preview.ts"
shot "file://$dir/preview.html" 1040,790 "$dir/screenshots/preview.png" 2
