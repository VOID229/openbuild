#!/usr/bin/env bash
# Renders 512px PNGs of every SVG and the compact comparison image with headless Chromium.
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
# 2 rows: 24 + 220 + 24 + 220 + 24 = 512 tall; width fits two tiles plus the icon strip.
shot "file://$dir/sheet.html?final" 798,512 "$dir/screenshots/marks.png" 2
shot "file://$dir/sheet.html" 798,756 "$dir/screenshots/explorations.png" 2
