
import os, math, random
from PIL import Image, ImageDraw

OUT = 'F:/inkflow app/InkFlow_Project/inkflow_harvests/data/elements'
os.makedirs(OUT, exist_ok=True)

PINK = (245, 160, 181)
DARK_PINK = (220, 120, 150)
WHITE = (255, 255, 255)
GOLD = (218, 180, 120)
INK_BLACK = (20, 20, 25)
INK_DARK = (40, 35, 45)
PINK_INK = (200, 80, 120)

def make_star(size, color, points=5, outer_ratio=0.5):
    img = Image.new('RGBA', (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    cx = cy = size // 2
    outer_r = size // 2 - 2
    inner_r = int(outer_r * outer_ratio)
    angles = []
    for i in range(points * 2):
        r = outer_r if i % 2 == 0 else inner_r
        a = math.radians(-90 + i * 180 / points)
        angles.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    draw.polygon(angles, fill=color + (255,))
    return img

def make_heart(size, color):
    img = Image.new('RGBA', (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    cx = cy = size // 2
    r = size // 4
    draw.ellipse([cx - r, cy - r, cx, cy + r], fill=color + (255,))
    draw.ellipse([cx, cy - r, cx + r, cy + r], fill=color + (255,))
    draw.polygon([(cx - r - 2, cy + int(r*0.2)), (cx + r + 2, cy + int(r*0.2)), (cx, cy + r * 2)], fill=color + (255,))
    return img

def make_dot(size, color):
    img = Image.new('RGBA', (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([2, 2, size-2, size-2], fill=color + (255,))
    return img

def make_ring(size, color):
    img = Image.new('RGBA', (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([3, 3, size-3, size-3], outline=color + (200,), width=2)
    return img

def ink_teardrop(w, h, color):
    img = Image.new('RGBA', (w, h), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    cx, cy = w // 2, h // 2
    rx, ry = w // 2 - 1, h // 3
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=color + (230,))
    tip_w = max(2, w // 6)
    draw.polygon([(cx - tip_w, cy), (cx + tip_w, cy), (cx, h-1)], fill=color + (230,))
    hl_color = (255, 255, 255, 100)
    draw.ellipse([cx - rx//3, cy - ry//2, cx + rx//4, cy + ry//4], fill=hl_color)
    return img

def ink_splash(r, color):
    size = r * 2 + 20
    img = Image.new('RGBA', (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    cx = cy = size // 2
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (200,))
    for _ in range(12):
        angle = random.uniform(0, 2 * math.pi)
        dist = random.randint(r + 2, r + 12)
        dx, dy = int(dist * math.cos(angle)), int(dist * math.sin(angle))
        dr = random.randint(1, 4)
        alpha = random.randint(100, 200)
        draw.ellipse([cx + dx - dr, cy + dy - dr, cx + dx + dr, cy + dy + dr], fill=color + (alpha,))
    return img

print('=== Peach Elements Generator ===')
for sz, label in [(24, 'sm'), (36, 'md'), (48, 'lg')]:
    for color, cname in [(PINK, 'pink'), (WHITE, 'white')]:
        make_star(sz, color).save(os.path.join(OUT, 'star_'+cname+'_'+label+'.png'))
        print('  star_'+cname+'_'+label+'.png')

for sz, label in [(28, 'sm'), (40, 'md'), (52, 'lg')]:
    for color, cname in [(PINK, 'pink'), (DARK_PINK, 'dark')]:
        make_heart(sz, color).save(os.path.join(OUT, 'heart_'+cname+'_'+label+'.png'))
        print('  heart_'+cname+'_'+label+'.png')

for sz, color, cname in [(12, PINK, 'pink'), (18, PINK, 'pink'), (24, PINK, 'pink'), (12, WHITE, 'white'), (18, WHITE, 'white')]:
    make_dot(sz, color).save(os.path.join(OUT, 'dot_'+cname+'_'+str(sz)+'.png'))
    print('  dot_'+cname+'_'+str(sz)+'.png')

for sz, label in [(30, 'sm'), (50, 'md'), (70, 'lg')]:
    for color, cname in [(PINK, 'pink'), (GOLD, 'gold'), (WHITE, 'white')]:
        make_ring(sz, color).save(os.path.join(OUT, 'ring_'+cname+'_'+label+'.png'))
        print('  ring_'+cname+'_'+label+'.png')

print()
for w, h, label in [(20, 40, 'tiny'), (30, 60, 'small'), (42, 80, 'medium'), (54, 100, 'large')]:
    for color, cname in [(INK_BLACK, 'black'), (PINK_INK, 'pink')]:
        ink_teardrop(w, h, color).save(os.path.join(OUT, 'ink_teardrop_'+cname+'_'+label+'.png'))
        print('  ink_teardrop_'+cname+'_'+label+'.png')

for r, label in [(12, 'sm'), (20, 'md'), (30, 'lg')]:
    for color, cname in [(INK_BLACK, 'black'), (PINK_INK, 'pink')]:
        ink_splash(r, color).save(os.path.join(OUT, 'ink_splash_'+cname+'_'+label+'.png'))
        print('  ink_splash_'+cname+'_'+label+'.png')

total = len(os.listdir(OUT))
print('Done -', total, 'elements in', OUT)
