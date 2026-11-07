#!/usr/bin/env bash
# Renders 512px PNGs of every SVG and the contact-sheet screenshots with headless Chromium.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
chrome="${CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | tail -1)}"
shot() { "$chrome" --headless=new --no-sandbox --hide-scrollbars --disable-gpu --force-device-scale-factor="${4:-1}" \
  --default-background-color=00000000 --virtual-time-budget=2000 \
  --window-size="$2" --screenshot="$3" "$1" >/dev/null 2>&1; }

mkdir -p "$dir/png" "$dir/screenshots"
for svg in "$dir"/svg/*.svg; do
  shot "file://$svg" 512,512 "$dir/png/$(basename "${svg%.svg}").png"
done
shot "file://$dir/board.html" 1440,1000 "$dir/screenshots/contact-sheet.png"
for id in a b c; do
  shot "file://$dir/board.html?only=$id" 1440,360 "$dir/screenshots/contact-sheet-$id.png" 2
done
ls "$dir/png" "$dir/screenshots"
