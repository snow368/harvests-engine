"""批量生成 Peach IG 帖"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

OUT = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/generated_samples"
PHOTOS = "G:/PMU/Peach Pictures"

def make_post(src_path, label, txt_color=(255,255,255,235), sub_color=(180,180,185,180)):
    src = Image.open(src_path).convert("RGBA")
    w, h = src.size

    canvas = Image.new("RGBA", (1080, 1350), (35, 35, 38, 255))
    draw = ImageDraw.Draw(canvas)

    for y in range(1350):
        r = int(35 + y/1350 * 12)
        g = int(35 + y/1350 * 10)
        b = int(38 + y/1350 * 8)
        draw.line([(0, y), (1080, y)], fill=(r, g, b, 255))

    # 背景装饰：淡色线条（Kwadron风格）
    draw.line([(100, 300), (100, 1100)], fill=(245, 160, 181, 12), width=2)
    draw.line([(980, 300), (980, 1100)], fill=(245, 160, 181, 12), width=2)
    draw.line([(50, 350), (1030, 350)], fill=(245, 160, 181, 8), width=1)
    draw.line([(50, 1050), (1030, 1050)], fill=(245, 160, 181, 8), width=1)

    # 极淡的对角线装饰
    for x in range(0, 1080, 120):
        draw.line([(x, 200), (x+60, 250)], fill=(245, 160, 181, 6), width=1)

    # Logo
    logo = Image.open(os.path.join(PHOTOS, "微信图片_20260528154254_447_619.png")).convert("RGBA")
    logo_top = logo.resize((90, 90), Image.LANCZOS)
    canvas.paste(logo_top, (50, 40), logo_top)

    try:
        f1 = ImageFont.truetype("arial.ttf", 52)
        f2 = ImageFont.truetype("arial.ttf", 22)
        f3 = ImageFont.truetype("arial.ttf", 20)
    except:
        f1 = f2 = f3 = ImageFont.load_default()

    draw.text((155, 45), "PEACH", fill=txt_color, font=f1)
    draw.text((155, 105), "PREMIUM TATTOO CARTRIDGE", fill=sub_color, font=f2)

    # Left: photo
    left = src.crop((50, 0, w-50, h-200))
    left = left.resize((450, 600), Image.LANCZOS)
    canvas.paste(left, (45, 200), left)

    # Right: tip zoom
    tip = src.crop((80, h-280, w-80, h-60))
    tip_zoom = tip.resize((470, 470), Image.LANCZOS)
    mask = Image.new("RGBA", (470, 470), (0,0,0,0))
    ImageDraw.Draw(mask).ellipse([0,0,470,470], fill=(255,255,255,255))
    bg = Image.new("RGBA", (470, 470), (40,40,43,255))
    tip_circle = Image.composite(tip_zoom, bg, mask)
    canvas.paste(tip_circle, (540, 200), tip_circle)
    draw.ellipse([540, 200, 1010, 670], outline=(245, 160, 181, 60), width=2)

    draw.text((540, 1280), "#peachtattoo  #tattoocartridge  #tattoosupply", fill=sub_color, font=f3, anchor="mm")

    safe = label.replace(" ", "_")
    out_path = os.path.join(OUT, f"peach_post_{safe}.png")
    canvas.save(out_path)
    print(f"  OK → peach_post_{safe}.png")

# === 批量生成 ===
print("Generating posts...\n")

# 1-3: 用户拍的三张
for i in range(1, 4):
    fname = f"微信图片_2026060116013{8+(i-1)*2}_{588 if i==1 else 589 if i==2 else 590}_696.jpg"
    # Try different filenames
    candidates = [
        f"微信图片_2026060116013{8+(i-1)*2}_{588 if i==1 else 589 if i==2 else 590}_696.jpg",
        f"微信图片_20260601160138_588_696.jpg",
        f"微信图片_20260601160140_589_696.jpg",
        f"微信图片_20260601160143_590_696.jpg",
    ]
    path = os.path.join(PHOTOS, candidates[min(i-1, len(candidates)-1)])
    if os.path.exists(path):
        make_post(path, f"shot_{i}")

# 4: COG 图
cog_path = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/peach_products/COG/Peach COG-2.jpg"
if os.path.exists(cog_path):
    make_post(cog_path, "cog", txt_color=(245,160,181,235), sub_color=(180,180,185,180))

# 5: COG 另一张
cog_path2 = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/peach_products/COG/Peach COG-3.jpg"
if os.path.exists(cog_path2):
    make_post(cog_path2, "cog_2", txt_color=(245,160,181,235), sub_color=(180,180,185,180))

print(f"\nDone → {OUT}")
