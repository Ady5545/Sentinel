#!/usr/bin/env python3
"""Create reproducible SENTINEL application icons for macOS and Windows."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

# Draw at 2x scale for smooth edges, then package platform-specific formats.
size = 1024
image = Image.new("RGBA", (size, size), "#11171d")
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=220, fill="#11171d")

shield = [
    (512, 110), (802, 208), (802, 440), (798, 480), (787, 522),
    (770, 565), (745, 605), (711, 645), (672, 679), (625, 714),
    (512, 774), (399, 714), (352, 679), (313, 645), (279, 605),
    (254, 565), (237, 522), (226, 480), (222, 440), (222, 208)
]
draw.polygon(shield, fill="#203a32")
draw.line(shield + [shield[0]], fill="#b8d8c8", width=17, joint="curve")
draw.line([(388, 406), (636, 406)], fill="#9ad0b6", width=18)
draw.line([(388, 514), (636, 514)], fill="#9ad0b6", width=18)
draw.line([(512, 302), (512, 724)], fill="#9ad0b6", width=18)
draw.ellipse((582, 460, 690, 568), fill="#d9b47a", outline="#11171d", width=10)

png = OUT / "icon.png"
ico = OUT / "icon.ico"
icns = OUT / "icon.icns"
image.save(png, format="PNG", optimize=True)
image.save(ico, format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
image.save(icns, format="ICNS", sizes=[(1024, 1024), (512, 512), (256, 256), (128, 128), (64, 64), (32, 32), (16, 16)])
print("Generated", png.relative_to(ROOT), ico.relative_to(ROOT), icns.relative_to(ROOT))
