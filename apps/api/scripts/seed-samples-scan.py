#!/usr/bin/env python3
"""Turns the ISO 9001 certificate PDF into a PNG that looks like a flatbed scan (slight rotation, paper tint, noise, vignette).
Usage: seed-samples-scan.py <certificate.pdf> <out.png>   (needs macOS sips and Pillow)"""
import random, subprocess, sys, tempfile, os
from PIL import Image, ImageFilter, ImageEnhance, ImageChops

src, out = sys.argv[1], sys.argv[2]
tmp = os.path.join(tempfile.mkdtemp(), 'page.png')
subprocess.run(['sips', '-s', 'format', 'png', '--resampleWidth', '980', src, '--out', tmp], check=True, capture_output=True)
random.seed(9001)
raw = Image.open(tmp).convert('RGBA')
im = Image.new('RGB', raw.size, (255, 255, 255))
im.paste(raw, mask=raw.split()[3])
paper = Image.new('RGB', im.size, (244, 240, 228))
im = ImageChops.multiply(im, paper)
im = im.rotate(-0.9, resample=Image.BICUBIC, expand=True, fillcolor=(236, 233, 224))
im = im.filter(ImageFilter.GaussianBlur(0.7))
pass
pass
w, h = im.size
vig = Image.new('L', (w, h), 255)
px = vig.load()
for y in range(0, h):
    for x in range(0, w, 2):
        d = ((x - w / 2) ** 2 / (w / 2) ** 2 + (y - h / 2) ** 2 / (h / 2) ** 2) ** 0.5
        v = int(255 - max(0, d - 0.75) * 120)
        px[x, y] = v
        if x + 1 < w: px[x + 1, y] = v
im = ImageChops.multiply(im, Image.merge('RGB', (vig, vig, vig)))
im = ImageEnhance.Contrast(im).enhance(0.95)
im = im.quantize(colors=40, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
im.save(out, optimize=True)
print(out, os.path.getsize(out))
