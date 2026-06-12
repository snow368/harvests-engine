"""生成墨滴/出墨效果PNG — 用于合成到针尖"""
import os, math, random
from PIL import Image, ImageDraw

OUT = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/elements"
os.makedirs(OUT, exist_ok=True)

INK_BLACK = (20, 20, 25)
INK_DARK = (40, 35, 45)
PINK_INK = (200, 80, 120)

def teardrop(w, h, color, highlight=True):
    """泪滴形墨滴"""
    img = Image.new("RGBA", (w, h), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    cx, cy = w // 2, h // 2
    rx, ry = w // 2 - 1, h // 3
    # 上半椭圆（墨滴主体）
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=color + (230,))
    # 下半锥形
    tip_w = max(2, w // 6)
    draw.polygon([(cx - tip_w, cy), (cx + tip_w, cy), (cx, h-1)], fill=color + (230,))
    # 高光
    if highlight:
        hl_color = (255, 255, 255, 100)
        draw.ellipse([cx - rx//3, cy - ry//2, cx + rx//4, cy + ry//4], fill=hl_color)
    return img

def ink_splash(r, color, n_dots=12):
    """墨水飞溅"""
    size = r * 2 + 20
    img = Image.new("RGBA", (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    cx = cy = size // 2
    # 主墨滴
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (200,))
    # 飞散小点
    for _ in range(n_dots):
        angle = random.uniform(0, 2 * math.pi)
        dist = random.randint(r + 2, r + 12)
        dx = int(dist * math.cos(angle))
        dy = int(dist * math.sin(angle))
        dr = random.randint(1, 4)
        alpha = random.randint(100, 200)
        draw.ellipse([cx + dx - dr, cy + dy - dr, cx + dx + dr, cy + dy + dr],
                     fill=color + (alpha,))
    return img

def ink_drip(h, color, max_w=6):
    """垂落的墨线"""
    img = Image.new("RGBA", (max_w * 2 + 4, h), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    cx = max_w + 2
    # 上粗下细的墨线
    for y in range(h):
        w = max(1, int(max_w * (1 - y / h * 0.8)))
        alpha = max(60, int(200 * (1 - y / h * 0.7)))
        draw.ellipse([cx - w//2, y, cx + w//2, y+1], fill=color + (alpha,))
    # 底部墨珠
    br = max(2, max_w // 2)
    draw.ellipse([cx - br, h - br*2, cx + br, h], fill=color + (220,))
    return img

def clustered_drops(count, spread, color):
    """一组墨滴聚集"""
    size = spread * 2 + 30
    img = Image.new("RGBA", (size, size), (0,0,0,0))
    draw = ImageDraw.Draw(img)
    cx = cy = size // 2
    for _ in range(count):
        ox = random.randint(-spread, spread)
        oy = random.randint(-spread, spread)
        r = random.randint(3, 8)
        al = random.randint(150, 230)
        draw.ellipse([cx + ox - r, cy + oy - r, cx + ox + r, cy + oy + r],
                     fill=color + (al,))
        # 小高光
        hl = int(r * 0.3)
        if hl > 1:
            draw.ellipse([cx + ox - hl, cy + oy - hl, cx + ox, cy + oy],
                         fill=(255, 255, 255, 60))
    return img

print("=== 生成墨滴效果素材 ===\n")

# 1. 泪滴形 — 用在针尖
for w, h, label in [(20, 40, 'tiny'), (30, 60, 'small'), (42, 80, 'medium'), (54, 100, 'large')]:
    for color, cname in [(INK_BLACK, 'black'), (PINK_INK, 'pink')]:
        img = teardrop(w, h, color)
        fname = f"ink_teardrop_{cname}_{label}.png"
        img.save(os.path.join(OUT, fname))
        print(f"  💧 {fname}")

# 2. 飞溅
for r, label in [(12, 'sm'), (20, 'md'), (30, 'lg')]:
    for color, cname in [(INK_BLACK, 'black'), (PINK_INK, 'pink')]:
        img = ink_splash(r, color)
        fname = f"ink_splash_{cname}_{label}.png"
        img.save(os.path.join(OUT, fname))
        print(f"  💥 {fname}")

# 3. 垂落墨线
for h, label in [(60, 'short'), (100, 'medium'), (150, 'long')]:
    for color, cname in [(INK_BLACK, 'black'), (INK_DARK, 'dark')]:
        img = ink_drip(h, color)
        fname = f"ink_drip_{cname}_{label}.png"
        img.save(os.path.join(OUT, fname))
        print(f"  🕸 {fname}")

# 4. 墨滴聚集
for count, spread, label in [(5, 15, 'tiny'), (10, 25, 'small'), (20, 40, 'medium')]:
    for color, cname in [(INK_BLACK, 'black'), (PINK_INK, 'pink')]:
        img = clustered_drops(count, spread, color)
        fname = f"ink_cluster_{cname}_{label}.png"
        img.save(os.path.join(OUT, fname))
        print(f"  🔵 {fname}")

total = len([f for f in os.listdir(OUT) if f.startswith('ink_')])
print(f"\n✅ 墨滴素材已保存 → {OUT} ({total}个)")
