# python3 -I sim.py in.png out-prefix: what a capture looks like on displays that lift near-black,
# re-encoded for a reference screen (gamma 2.2, true black) like a Mac's. Prints the level table with no args.
import sys

def srgb_decode(v):  # piecewise sRGB, with its linear toe: brighter than gamma 2.2 near black
    c = v / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def g(v, gamma):
    return (v / 255) ** gamma

CURVES = {
    # Panels and pipelines that decode near-black with sRGB's linear toe (Windows HDR/ACM, a colour-managed
    # Chromium on KDE re-encoding for a gamma 2.2 output) on a 1000:1 IPS panel (black at 0.1% of white).
    "toe": lambda v: 0.001 + 0.999 * srgb_decode(v),
    # A gaming monitor's shadow boost (MSI Night Vision, Dell Dark Stabilizer): gamma ~1.7 near black, 1000:1.
    "boost": lambda v: 0.0015 + 0.9985 * g(v, 1.7),
}

def lut(curve):
    return [round(255 * CURVES[curve](v) ** (1 / 2.2)) for v in range(256)]

if __name__ == "__main__":
    if len(sys.argv) < 3:
        for v in [0, 10, 14, 18, 20, 22, 26, 30, 34, 38, 42, 48, 56, 64, 96, 161, 237]:
            print(v, *(f"{c}={lut(c)[v]}" for c in CURVES))
        sys.exit()
    from PIL import Image
    im = Image.open(sys.argv[1]).convert("RGB")
    for c in CURVES:
        im.point(lut(c) * 3).save(f"{sys.argv[2]}-{c}.png")
