import os
import math
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "icons")

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def rounded_rect(draw, xy, radius, fill):
    draw.rounded_rectangle(xy, radius=radius, fill=fill)

def render(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background rounded square with gradient (top-left -> bottom-right)
    pad = int(size * 0.02)
    box = (pad, pad, size - pad, size - pad)
    radius = int(size * 0.22)
    steps = 120
    for i in range(steps):
        t = i / (steps - 1)
        y = box[1] + i * (box[3] - box[1]) / steps
        y_next = box[1] + (i + 1) * (box[3] - box[1]) / steps
        c = lerp((45, 56, 150), (124, 58, 237), t)
        draw.rectangle((box[0], y, box[2], y_next), fill=(c[0], c[1], c[2], 255))

    # Soft inner glow (lighter at top)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i in range(steps):
        t = i / (steps - 1)
        y = box[1] + i * (box[3] - box[1]) / steps
        y_next = box[1] + (i + 1) * (box[3] - box[1]) / steps
        c = lerp((160, 170, 255), (109, 92, 255), t)
        gd.rectangle((box[0], y, box[2], y_next), fill=(c[0], c[1], c[2], 28))
    img = Image.alpha_composite(img, glow)

    # Glass shine on top edge
    shine = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shine)
    top_h = int(size * 0.22)
    for i in range(top_h):
        t = 1 - i / top_h
        y = box[1] + i
        sd.rectangle((box[0] + pad, y, box[2] - pad, y + 1), fill=(255, 255, 255, int(34 * t)))
    img = Image.alpha_composite(img, shine)

    # Rounded mask (clip corners)
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle(box, radius=radius, fill=255)
    img.putalpha(mask)

    # Center glyph: stylized "H" made from two pillars + bridge, plus a spark dot
    w = int(size * 0.52)
    thickness = int(size * 0.10)
    gap = int(size * 0.12)
    c0 = (size - w) / 2
    c1 = c0 + gap
    c2 = size / 2
    c3 = c0 + w - thickness
    top = int(size * 0.30)
    bottom = int(size * 0.70)
    bridge_y = int(size * 0.50)
    bridge_h = thickness

    glyph = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glyph)

    # Left pillar
    gd.rounded_rectangle((c0, top, c0 + thickness, bottom), radius=thickness // 2, fill=(255, 255, 255, 242))
    # Right pillar
    gd.rounded_rectangle((c3, top, c3 + thickness, bottom), radius=thickness // 2, fill=(255, 255, 255, 242))
    # Bridge
    gd.rounded_rectangle((c0, bridge_y, c3 + thickness, bridge_y + bridge_h), radius=bridge_h // 2, fill=(255, 255, 255, 242))

    img = Image.alpha_composite(img, glyph)

    # Spark dot (accent cyan) at top-right of glyph
    spark_r = int(size * 0.045)
    sx = c3 + thickness + int(size * 0.09)
    sy = top - int(size * 0.02)
    spark = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    spd = ImageDraw.Draw(spark)
    spd.ellipse((sx - spark_r, sy - spark_r, sx + spark_r, sy + spark_r), fill=(34, 211, 238, 255))
    img = Image.alpha_composite(img, spark)

    return img

def main():
    os.makedirs(OUT, exist_ok=True)
    sizes = {
        "mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192,
        "playstore": 512,
    }
    for name, s in sizes.items():
        img = render(s)
        img.save(os.path.join(OUT, f"icon-{name}.png"))
        print(f"  icon-{name}.png  {s}x{s}")

if __name__ == "__main__":
    main()
