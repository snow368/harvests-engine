import os, random
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/generated_samples"
os.makedirs(OUT_DIR, exist_ok=True)
RL_DIR = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/peach_products/RL"
COG_DIR = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/peach_products/COG"

def load_one(d):
    files = [f for f in os.listdir(d) if f.lower().endswith(('.png','.jpg'))]
    random.shuffle(files)
    return Image.open(os.path.join(d, files[0])).convert("RGBA")

def resize_img(img, target_h):
    w, h = img.size
    ratio = target_h / h
    return img.resize((int(w * ratio), target_h), Image.LANCZOS)

try:
    fnt = ImageFont.truetype("arial.ttf", 32)
except:
    fnt = ImageFont.load_default()

# ── 1. 微距裁切 ──
print("=== 微距裁切 ===")
for i in range(3):
    img = load_one(RL_DIR)
    w, h = img.size
    crops = [
        ("tip", 0, int(h*0.3)),
        ("body", int(h*0.25), int(h*0.65)),
        ("base", int(h*0.7), h),
    ]
    for key, y1, y2 in crops:
        c = img.crop((0, y1, w, y2))
        side = max(c.size)
        sq = Image.new("RGBA", (side, side), (0,0,0,0))
        sq.paste(c, ((side-c.width)//2, (side-c.height)//2))
        sq = sq.resize((540, 540), Image.LANCZOS)
        bg = Image.new("RGBA", (540, 540), (28,28,33,255))
        bg.paste(sq, (0,0), sq)
        bg.save(os.path.join(OUT_DIR, f"macro_{key}_{i}.png"))
        print(f"  {key} → macro_{key}_{i}.png")

# ── 2. 对比图 ──
print("\n=== 对比图 ===")
rl = resize_img(load_one(RL_DIR), 400)
cog = resize_img(load_one(COG_DIR), 400)
gap = 30
pw = rl.width + cog.width + gap * 3
ph = 400 + 80
bg = Image.new("RGBA", (pw, ph), (28,28,33,255))
bg.paste(rl, (gap, 60), rl)
bg.paste(cog, (gap*2 + rl.width, 60), cog)
d = ImageDraw.Draw(bg)
d.text((gap + rl.width//2 - 20, 15), "RL", fill=(255,200,200,220), font=fnt)
d.text((gap*2 + rl.width + cog.width//2 - 30, 15), "COG", fill=(200,200,255,220), font=fnt)
bg.save(os.path.join(OUT_DIR, "compare_rl_vs_cog.png"))
print("  RL vs COG done")

rl2 = resize_img(load_one(RL_DIR), 400)
cog2 = resize_img(load_one(COG_DIR), 400)
pw2 = rl2.width + cog2.width + gap * 3
bg2 = Image.new("RGBA", (pw2, ph), (28,28,33,255))
bg2.paste(rl2, (gap, 60), rl2)
bg2.paste(cog2, (gap*2 + rl2.width, 60), cog2)
d2 = ImageDraw.Draw(bg2)
d2.text((gap + rl2.width//2 - 50, 15), "Standard", fill=(255,200,200,220), font=fnt)
d2.text((gap*2 + rl2.width + cog2.width//2 - 30, 15), "SEM", fill=(200,200,255,220), font=fnt)
bg2.save(os.path.join(OUT_DIR, "compare_standard_vs_sem.png"))
print("  Standard vs SEM done")

print(f"\nOK")
