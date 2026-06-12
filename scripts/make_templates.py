"""Peach 模板生成器 — 去掉手指、图上文字、标注线、斜角构图"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/generated_samples"
LOGO = Image.open("G:/PMU/Peach Pictures/微信图片_20260528154254_447_619.png").convert("RGBA")
PHOTOS = "G:/PMU/Peach Pictures"

PINK = (245, 160, 181, 255)
WHITE = (255, 255, 255, 230)
GRAY = (180, 180, 185, 140)

try:
    f_big = ImageFont.truetype("arial.ttf", 52)
    f_mid = ImageFont.truetype("arial.ttf", 22)
    f_tag = ImageFont.truetype("arial.ttf", 18)
    f_callout = ImageFont.truetype("arial.ttf", 20)
except:
    f_big = f_mid = f_tag = f_callout = ImageFont.load_default()


def load_clean(src_path):
    """加载图片并尽量去掉背景"""
    img = Image.open(src_path).convert("RGBA")
    w, h = img.size
    px = img.load()
    # 暴力去浅色背景（手指保留不了，只能裁剪）
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y][:4]
            if r > 230 and g > 230 and b > 230:
                px[x, y] = (r, g, b, 0)
    # 裁剪内容区域，尽量去掉手指
    first_y, last_y = h, 0
    first_x, last_x = w, 0
    for y in range(h):
        for x in range(w):
            if img.getpixel((x, y))[3] > 30:
                first_y = min(first_y, y)
                last_y = max(last_y, y)
                first_x = min(first_x, x)
                last_x = max(last_x, x)
    # 紧切，不要太多留白
    return img.crop((first_x, max(0, first_y-10), last_x, min(h, last_y+10)))


def diagonal_product(img, max_w=650):
    """把产品旋转斜放"""
    w, h = img.size
    scale = min(max_w / w, 850 / h, 1.0)
    img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    rotated = img.rotate(-12, expand=True, center=None)  # 斜12度
    return rotated


def gradient_bg(draw, w=1080, h=1350):
    for y in range(h):
        r = int(35 + y/h * 12)
        g = int(35 + y/h * 10)
        b = int(38 + y/h * 8)
        draw.line([(0, y), (w, y)], fill=(r, g, b, 255))


def template_a(src_path, label):
    """模板A：斜角产品 + 标注线 + 图上文字"""
    src = load_clean(src_path)
    canvas = Image.new("RGBA", (1080, 1350), (0,0,0,0))
    draw = ImageDraw.Draw(canvas)
    gradient_bg(draw)

    # Logo 顶
    logo_sm = LOGO.resize((80, 80), Image.LANCZOS)
    canvas.paste(logo_sm, (60, 30), logo_sm)
    draw.text((155, 38), "PEACH", fill=WHITE, font=f_big)
    draw.text((155, 95), "PREMIUM TATTOO CARTRIDGE", fill=GRAY, font=f_mid)

    # 斜角产品
    prod = diagonal_product(src)
    pw, ph = prod.size
    px = (1080 - pw) // 2
    py = 200
    canvas.paste(prod, (px, py), prod)

    # 标注线（左侧）
    lx = px - 20
    ly1 = py + int(ph * 0.2)
    draw.line([(lx, ly1), (50, ly1)], fill=PINK, width=2)
    draw.line([(lx, ly1), (lx, ly1 + 15)], fill=PINK, width=2)
    draw.text((55, ly1 - 22), "Tip", fill=WHITE, font=f_callout)

    # 标注线（右侧）
    rx = px + pw + 20
    ly2 = py + int(ph * 0.55)
    draw.line([(rx, ly2), (1030, ly2)], fill=PINK, width=2)
    draw.line([(rx, ly2), (rx, ly2 - 15)], fill=PINK, width=2)
    draw.text((850, ly2 - 22), "Peach Housing", fill=WHITE, font=f_callout)

    # 图上大字（底部）
    draw.text((540, 1150), "PRECISION", fill=(245, 160, 181, 120), font=ImageFont.truetype("arial.ttf", 72), anchor="mm")
    draw.text((540, 1210), "PEACH TATTOO CARTRIDGE", fill=WHITE, font=f_mid, anchor="mm")

    # 底部标签
    draw.text((540, 1320), "#peachtattoo  #tattoocartridge  #tattoosupply", fill=GRAY, font=f_tag, anchor="mm")

    out = os.path.join(OUT, f"peach_a_{label}.png")
    canvas.save(out)
    print(f"  A-{label}")


def template_b(src_path, label):
    """模板B：斜角产品 + 圆形放大 + 标注线"""
    src = load_clean(src_path)
    canvas = Image.new("RGBA", (1080, 1350), (0,0,0,0))
    draw = ImageDraw.Draw(canvas)
    gradient_bg(draw)

    # Logo 顶
    logo_sm = LOGO.resize((80, 80), Image.LANCZOS)
    canvas.paste(logo_sm, (60, 30), logo_sm)
    draw.text((155, 38), "PEACH", fill=WHITE, font=f_big)
    draw.text((155, 95), "PREMIUM TATTOO CARTRIDGE", fill=GRAY, font=f_mid)

    # 左边：斜角产品
    prod = diagonal_product(src, 460)
    pw, ph = prod.size
    px, py = 30, 350
    canvas.paste(prod, (px, py), prod)

    # 右边：针尖放大
    sw, sh = src.size
    tip = src.crop((int(sw*0.1), int(sh*0.75), int(sw*0.9), sh))
    tip_zoom = tip.resize((360, 360), Image.LANCZOS)
    mask = Image.new("RGBA", (360, 360), (0,0,0,0))
    ImageDraw.Draw(mask).ellipse([0,0,360,360], fill=(255,255,255,255))
    bg = Image.new("RGBA", (360, 360), (40,40,43,255))
    tip_circle = Image.composite(tip_zoom, bg, mask)
    cx, cy = 580, 380
    canvas.paste(tip_circle, (cx, cy), tip_circle)
    draw.ellipse([cx, cy, cx+360, cy+360], outline=(PINK[0], PINK[1], PINK[2], 80), width=2)

    # 标注线：从产品底部→放大圈
    draw.line([(px + pw, py + ph - 30), (cx + 30, cy + 180)], fill=(245, 160, 181, 60), width=1)

    # 放大圈标签
    draw.text((cx + 100, cy + 365), "TIP ZOOM", fill=GRAY, font=f_callout, anchor="mm")

    # 图上大字
    draw.text((540, 1150), "PRECISION", fill=(245, 160, 181, 120), font=ImageFont.truetype("arial.ttf", 72), anchor="mm")

    # 底部
    draw.text((540, 1320), "#peachtattoo  #tattoocartridge", fill=GRAY, font=f_tag, anchor="mm")

    out = os.path.join(OUT, f"peach_b_{label}.png")
    canvas.save(out)
    print(f"  B-{label}")


# ===== 执行 =====
sources = [
    ("微信图片_20260601160138_588_696.jpg", "shot1"),
    ("微信图片_20260601160140_589_696.jpg", "shot2"),
    ("微信图片_20260601160143_590_696.jpg", "shot3"),
]

print("=== 模板A ===")
for fname, label in sources:
    path = os.path.join(PHOTOS, fname)
    if os.path.exists(path): template_a(path, label)

print("\n=== 模板B ===")
for fname, label in sources:
    path = os.path.join(PHOTOS, fname)
    if os.path.exists(path): template_b(path, label)

print(f"\nDone")
