"""Kwadron风格产品排列生成器 — 暗背景·戏剧光·动态构图"""
import os, math, random
from PIL import Image

OUT_DIR = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/generated_samples"
os.makedirs(OUT_DIR, exist_ok=True)

SRC = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/peach_products/RL"
files = [f for f in os.listdir(SRC) if f.endswith('.png') or f.endswith('.jpg')]

# 随机选4张图
random.shuffle(files)
selected = files[:4]

# 加载+去白底
cartridges = []
for f in selected:
    img = Image.open(os.path.join(SRC, f)).convert("RGBA")
    p = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = p[x, y]
            if a > 0 and r > 240 and g > 240 and b > 240:
                p[x, y] = (r, g, b, 0)
    cartridges.append(img)

# 4种排列方式，每张不同
configs = [
    # [布局, 针数, MAX_SIZE, RADIUS, 偏移角度, 背景色调]
    ("X形排列", 4, 420, 300, 45, (28, 30, 35)),
    ("十字排列", 4, 400, 280, 0, (25, 25, 30)),
    ("单根斜放", 1, 500, 0, 30, (30, 28, 32)),
    ("双根交叉", 2, 450, 180, 0, (26, 28, 33)),
    ("三根扇形", 3, 430, 250, 60, (29, 27, 34)),
    ("平行排列", 3, 350, 200, 0, (24, 26, 30)),
    ("上下错位", 2, 450, 200, 90, (27, 29, 32)),
]

CANVAS = 1080
CENTER = CANVAS // 2

for layout_name, n, max_size, radius, offset, bg_color in configs:
    use_imgs = cartridges[:min(n, len(cartridges))]
    N = len(use_imgs)

    # 渐变背景
    bg = Image.new("RGBA", (CANVAS, CANVAS), bg_color + (255,))
    bp = bg.load()
    for y in range(CANVAS):
        for x in range(CANVAS):
            dist = ((x - CENTER) ** 2 + (y - CENTER) ** 2) ** 0.5
            ratio = min(dist / 540, 1.0)
            r = min(255, bg_color[0] + int(ratio * 18))
            g = min(255, bg_color[1] + int(ratio * 15))
            b = min(255, bg_color[2] + int(ratio * 12))
            bp[x, y] = (r, g, b, 255)

    canvas = bg.copy()

    if N == 1:
        # 单根居中斜放
        c = use_imgs[0]
        cw, ch = c.size
        scale = min(max_size / cw, max_size / ch, 1.0)
        c = c.resize((int(cw*scale), int(ch*scale)), Image.LANCZOS)
        rotated = c.rotate(offset, expand=True)
        rw, rh = rotated.size
        canvas.paste(rotated, (CENTER - rw//2, CENTER - rh//2), rotated)
    elif N == 2 and layout_name == "双根交叉":
        for i, c in enumerate(use_imgs):
            cw, ch = c.size
            scale = min(max_size / cw, max_size / ch, 1.0)
            c = c.resize((int(cw*scale), int(ch*scale)), Image.LANCZOS)
            rot = 45 if i == 0 else -45
            rotated = c.rotate(rot, expand=True)
            rw, rh = rotated.size
            ox = CENTER - 30 + i * 60
            oy = CENTER
            canvas.paste(rotated, (ox - rw//2, oy - rh//2), rotated)
    elif layout_name == "上下错位":
        positions = [(CENTER, CENTER - 120), (CENTER, CENTER + 120)]
        for i, c in enumerate(use_imgs):
            cw, ch = c.size
            scale = min(max_size / cw, max_size / ch, 1.0)
            c = c.resize((int(cw*scale), int(ch*scale)), Image.LANCZOS)
            rotated = c.rotate(offset + 90 if i else offset, expand=True)
            rw, rh = rotated.size
            px, py = positions[i]
            canvas.paste(rotated, (px - rw//2, py - rh//2), rotated)
    else:
        # 圆形排列（X/十字/扇形）
        for i in range(N):
            c = use_imgs[i]
            cw, ch = c.size
            scale = min(max_size / cw, max_size / ch, 1.0)
            c = c.resize((int(cw*scale), int(ch*scale)), Image.LANCZOS)

            angle_deg = (360 / N) * i + offset
            rad = math.radians(angle_deg)
            rotate_deg = (90 - angle_deg) % 360
            rotated = c.rotate(rotate_deg, expand=True)
            rw, rh = rotated.size

            cx = CENTER + int(radius * math.cos(rad))
            cy = CENTER + int(radius * math.sin(rad))
            canvas.paste(rotated, (cx - rw//2, cy - rh//2), rotated)

    safe_name = layout_name.replace(" ", "_")
    path = os.path.join(OUT_DIR, f"peach_{safe_name}.png")
    canvas.save(path, "PNG")
    print(f"  {layout_name:10s} → {safe_name}.png")

print(f"\nOK → 已保存到 {OUT_DIR}")
