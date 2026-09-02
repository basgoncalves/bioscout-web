"""Generate BioScout Web app icons from the package logo."""
from PIL import Image
from collections import deque
import sys

SRC = sys.argv[1]
OUT = sys.argv[2]

src = Image.open(SRC).convert("RGBA")
w, h = src.size
px = src.load()

# The logo ships on an opaque grey plate. Flood fill from the edges so only
# background that actually touches the border goes transparent: a global colour
# key would punch holes in the grey inside the artwork itself.
bg = px[0, 0][:3]
def close(c, ref, tol=40):
    return all(abs(a - b) <= tol for a, b in zip(c[:3], ref))

seen = [[False] * h for _ in range(w)]
q = deque()
for x in range(w):
    q.append((x, 0)); q.append((x, h - 1))
for y in range(h):
    q.append((0, y)); q.append((w - 1, y))
while q:
    x, y = q.popleft()
    if x < 0 or y < 0 or x >= w or y >= h or seen[x][y]:
        continue
    if not close(px[x, y], bg):
        continue
    seen[x][y] = True
    px[x, y] = (0, 0, 0, 0)
    q.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])

logo = src.crop(src.getbbox())

def square(size, pad_frac=0.0, fill=None):
    canvas = Image.new("RGBA", (size, size), fill or (0, 0, 0, 0))
    inner = int(size * (1 - 2 * pad_frac))
    im = logo.copy()
    im.thumbnail((inner, inner), Image.LANCZOS)
    canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
    return canvas

square(512).save(f"{OUT}/icon-512.png")
square(192).save(f"{OUT}/icon-192.png")
square(180).save(f"{OUT}/apple-touch-icon.png")
square(256).save(f"{OUT}/logo.png")
# Maskable icons are cropped to a circle by the launcher, so the artwork sits
# inside a 10% safe zone on the brand ground rather than filling the square.
square(512, pad_frac=0.10, fill=(28, 74, 72, 255)).save(f"{OUT}/icon-maskable-512.png")
square(64).save(f"{OUT}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
print("ok")
