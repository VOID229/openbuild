# Dark theme looks grey in Chromium on KDE Wayland

## Symptom

In the dark theme the sidebar shows as a visibly lighter grey (about `#121212`) than the black main pane,
in Chromium on a KDE Plasma Wayland session. On macOS, or in the same Chromium under X11, it is the
theme's near-black `#0a0a0a`.

## Cause

Not OpenBuild's CSS. The page computes the same colours on every platform: the sidebar paints nothing
of its own and shows `body { background: var(--bg) }`, which is `#0a0a0a` in the dark theme. There is
no platform or user-agent check in the styles. A headless Chromium on Linux with a Linux user agent and
one with a macOS user agent render the sidebar as `rgb(10, 10, 10)`, pixel for pixel.

The lift happens after the page is drawn. Chromium on native Wayland (the default since it detects the
session) uses the `wp_color_manager_v1` protocol to tag its frames for the compositor. KWin then
converts them for the output: it decodes with the piecewise sRGB curve and encodes for an SDR output
with gamma 2.2. Those curves agree at black, white and the midtones and part ways near black, where
sRGB has its linear toe. So every dark grey is raised:

| page value | 0 | 2 | 5 | 10 | 18 | 20 | 30 | 40 | 64 | 128 | 255 |
| ---------- | - | - | - | -- | -- | -- | -- | -- | -- | --- | --- |
| on screen  | 0 | 9 | 13 | 18 | 25 | 27 | 35 | 44 | 66 | 127 | 255 |

Measured on CachyOS with KWin 6.8.2 and Chromium 157.0.8103.38: a ramp of greys in a Chromium window
inside a nested `kwin_wayland --virtual` session, captured with Spectacle. `#0a0a0a` (10) lands on 18,
the grey in the report, while the main pane's `#000` stays black. That's why only the sidebar looks
wrong. With `--disable-features=WaylandWpColorManagerV1`, or `--ozone-platform=x11`, the same capture is
1:1 (10 stays 10, and OpenBuild's sidebar measures `rgb(10, 10, 10)` again).

OpenBuild can't correct for this from the page. Nothing a page can query (user agent, `color-gamut`,
`dynamic-range`, a canvas readback) tells this pipeline apart from the X11 one, which renders
correctly. Darkening the tokens for Linux would make every other Linux setup too dark, and changing
them for everyone would change the Mac.

## Fix

Turn off Chromium's Wayland colour-management protocol. On Arch-based systems (CachyOS included) the
`chromium` launcher reads its flags from `~/.config/chromium-flags.conf`, one per line:

```
--disable-features=WaylandWpColorManagerV1
```

Then quit Chromium completely and start it again. (Arch's Google Chrome package reads
`~/.config/chrome-flags.conf` instead.) If the file already has a `--disable-features=` line, add the
feature to that line, comma-separated: a second `--disable-features` flag replaces the first. Running
Chromium under XWayland (`--ozone-platform=x11`) also gives 1:1 colours, at the cost of native Wayland.

To check it took, open `chrome://version` and look for the flag under "Command Line".
