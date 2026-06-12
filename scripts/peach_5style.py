"""Peach 5-Style Test Image Generator - 5 styles x 3 products = 15 images + ink effects"""
import os, math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/test_15"
ELEM = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/elements"
PCON = "G:/PMU/Peach Pictures"
PAES = "G:/PMU/AES白底图"
PCOG = "G:/PMU/Peach Pictures/COG"
LOGO_PATH = "G:/PMU/Peach Pictures/微信图片_20260528154254_447_619.png"
os.makedirs(OUT, exist_ok=True)

def le(f):
    return Image.open(os.path.join(ELEM, f)).convert("RGBA")

def pe(c, fn, x, y, rot=0):
    try:
        e = le(fn)
        if rot:
            e = e.rotate(rot, expand=True)
        c.paste(e, (x, y), e)
    except:
        pass

def grad(c, ct, cb):
    d = ImageDraw.Draw(c)
    w, h = c.size
    for y in range(h):
        r = int(ct[0] + (cb[0]-ct[0]) * y / h)
        g = int(ct[1] + (cb[1]-ct[1]) * y / h)
        b = int(ct[2] + (cb[2]-ct[2]) * y / h)
        d.line([(0, y), (w, y)], fill=(r, g, b, 255))

def logo(c, x=40, y=30, sz=70):
    if os.path.exists(LOGO_PATH):
        l = Image.open(LOGO_PATH).convert("RGBA").resize((sz, sz), Image.LANCZOS)
        c.paste(l, (x, y), l)

def fl(sz, b=False):
    try:
        return ImageFont.truetype("arialbd.ttf" if b else "arial.ttf", sz)
    except:
        return ImageFont.load_default()

def tx(d, t, x, y, f, c, a="mm"):
    try:
        d.text((x, y), t, fill=c, font=f, anchor=a)
    except:
        d.text((x, y), t, fill=c, font=f)

def load_img(d, filt=None):
    files = sorted([f for f in os.listdir(d) if f.lower().endswith((".png",".jpg"))])
    if filt:
        files = [f for f in files if filt in f]
    if not files:
        return None
    return Image.open(os.path.join(d, files[0])).convert("RGBA")

def crop_alpha(img, m=5):
    px = img.load()
    w, h = img.size
    fx, lx, fy, ly = w, 0, h, 0
    for y in range(h):
        for x in range(w):
            if px[x,y][3] > 20:
                fx, lx = min(fx,x), max(lx,x)
                fy, ly = min(fy,y), max(ly,y)
    if fx >= lx or fy >= ly:
        return img
    return img.crop((max(0,fx-m), max(0,fy-m), min(w,lx+m), min(h,ly+m)))

def rf(img, mw, mh):
    w, h = img.size
    s = min(mw/w if w else 1, mh/h if h else 1, 1.0)
    return img.resize((int(w*s), int(h*s)), Image.LANCZOS)

def ink_tip(c, tx, ty, color="black"):
    pool = [f for f in os.listdir(ELEM) if f.startswith("ink_teardrop_"+color)]
    if not pool:
        pool = [f for f in os.listdir(ELEM) if f.startswith("ink_teardrop")]
    if pool:
        ink = le(pool[0])
        c.paste(ink, (tx - ink.width//2, ty), ink)
    sp = [f for f in os.listdir(ELEM) if f.startswith("ink_splash_"+color)]
    if not sp:
        sp = [f for f in os.listdir(ELEM) if f.startswith("ink_splash")]
    if sp:
        s = le(sp[0])
        c.paste(s, (tx - s.width//2 + random.randint(-5,5), ty + random.randint(-3,10)), s)

def scatter(c, prefix, n=6):
    pool = [f for f in os.listdir(ELEM) if f.startswith(prefix)]
    if not pool:
        return
    random.shuffle(pool)
    for i in range(min(n, len(pool))):
        x = random.randint(30, 1050)
        y = random.randint(200, 1000)
        e = le(pool[i])
        if random.random() > 0.5:
            e = e.rotate(random.randint(0,360), expand=True)
        c.paste(e, (x, y), e)

# ============================================================
# STYLES
# ============================================================

def style_A(p, idx):
    r = 0
    c = Image.new("RGBA", (1080,1350))
    grad(c, (15,25,55), (60,65,75))
    d = ImageDraw.Draw(c)

    logo(c)
    tx(d, "PEACH", 120, 38, fl(48,True), (255,255,255,255))
    tx(d, "PRECISION TECHNOLOGY", 120, 90, fl(18), (160,170,190,220))

    for sp in [150,300,450,600,750]:
        d.line([(sp,200),(sp+40,1340)], fill=(100,150,255,18), width=1)

    if "con" in p:
        img = load_img(PCON, "438")
        if img:
            img = crop_alpha(img)
            img = rf(img, 480, 600).rotate(-8, expand=True)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 280), img)
            ink_tip(c, cx+img.width//2, 320, "black")
    elif "cog" in p:
        img = load_img(PCOG)
        if img:
            img = crop_alpha(rf(img, 520, 650))
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 250), img)
    elif "aes" in p:
        img = load_img(PAES)
        if img:
            img = crop_alpha(img).rotate(-5, expand=True)
            img = rf(img, 420, 580)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 300), img)

    pe(c, "ring_white_md.png", 80, 800, 30)
    pe(c, "ring_white_sm.png", 920, 500, 15)
    tx(d, "TECH PRECISION", 540, 1150, fl(62,True), (100,150,255,180))
    tx(d, p.upper() + "  #peachtattoo", 540, 1310, fl(18), (120,130,150,200))

    fn = f"test_A_{p}.png"
    c.save(os.path.join(OUT, fn))
    print(f"  [A] {fn}")

def style_B(p, idx):
    c = Image.new("RGBA", (1080,1350))
    grad(c, (245,180,195), (220,140,160))
    d = ImageDraw.Draw(c)

    logo(c)
    tx(d, "PEACH", 120, 38, fl(48,True), (255,255,255,250))
    tx(d, "PREMIUM TATTOO CARTRIDGE", 120, 90, fl(18), (255,255,255,180))

    scatter(c, "star_", 8)
    scatter(c, "dot_pink_", 10)
    pe(c, "heart_pink_md.png", 900, 200, 20)

    if "aes" in p:
        img = load_img(PAES)
        if img:
            img = crop_alpha(img).rotate(-5, expand=True)
            img = rf(img, 450, 550)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 300), img)
    elif "con" in p:
        img = load_img(PCON, "438")
        if img:
            img = crop_alpha(img)
            img = rf(img, 400, 600).rotate(-12, expand=True)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 280), img)
            ink_tip(c, cx+img.width//2, 360, "pink")
    elif "cog" in p:
        img = load_img(PCOG)
        if img:
            img = crop_alpha(rf(img, 500, 600))
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 270), img)

    tx(d, "PEACH PINK", 540, 1150, fl(60,True), (255,255,255,200))
    tx(d, p.upper() + "  #peachtattoo", 540, 1310, fl(18), (255,255,255,180))

    fn = f"test_B_{p}.png"
    c.save(os.path.join(OUT, fn))
    print(f"  [B] {fn}")

def style_C(p, idx):
    c = Image.new("RGBA", (1080,1350))
    grad(c, (100,130,105), (70,95,75))
    d = ImageDraw.Draw(c)

    logo(c)
    tx(d, "PEACH", 120, 38, fl(48,True), (220,240,220,250))
    tx(d, "NATURE + TECHNOLOGY", 120, 90, fl(18), (180,210,180,200))

    for _ in range(15):
        x, y = random.randint(50,1030), random.randint(200,1000)
        r = random.randint(3,8)
        d.ellipse([x-r,y-r,x+r,y+r], fill=(180,220,170,random.randint(30,70)))

    pe(c, "ring_gold_md.png", 150, 700, 45)

    if "con" in p:
        img = load_img(PCON, "441")
        if img:
            img = crop_alpha(img).rotate(-5, expand=True)
            img = rf(img, 480, 600)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 250), img)
            ink_tip(c, cx+img.width//2, 280, "black")
    elif "cog" in p:
        img = load_img(PCOG)
        if img:
            img = crop_alpha(rf(img, 520, 620))
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 250), img)
    elif "hand" in p:
        for f in os.listdir(PCON):
            if "588" in f and f.endswith(".jpg"):
                img = Image.open(os.path.join(PCON, f)).convert("RGBA")
                img = rf(img, 550, 700)
                cx = (1080 - img.width)//2
                c.paste(img, (cx, 200), img)
                break

    tx(d, "NATURAL PRECISION", 540, 1150, fl(56,True), (180,220,170,200))
    tx(d, p.upper() + "  #peachtattoo", 540, 1310, fl(18), (170,200,170,200))

    fn = f"test_C_{p}.png"
    c.save(os.path.join(OUT, fn))
    print(f"  [C] {fn}")

def style_D(p, idx):
    c = Image.new("RGBA", (1080,1350))
    grad(c, (60,15,25), (15,5,10))
    d = ImageDraw.Draw(c)

    logo(c)
    tx(d, "PEACH", 120, 38, fl(48,True), (220,200,200,250))
    tx(d, "LUXURY TECHNOLOGY", 120, 90, fl(18), (160,130,130,200))

    halo = Image.new("RGBA", (400,400))
    hd = ImageDraw.Draw(halo)
    for r in range(200, 0, -1):
        hd.ellipse([200-r,200-r,200+r,200+r], fill=(180,80,100,max(0,int(30*(1-r/200)))))
    halo = halo.filter(ImageFilter.GaussianBlur(20))
    c.paste(halo, (340,350), halo)

    pe(c, "ring_gold_lg.png", 60, 780, 15)
    pe(c, "ring_gold_sm.png", 940, 450, 30)

    if "con" in p:
        img = load_img(PCON, "444")
        if img:
            img = crop_alpha(img).rotate(-8, expand=True)
            img = rf(img, 450, 600)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 320), img)
            ink_tip(c, cx+img.width//2, 370, "black")
    elif "cog" in p:
        files = sorted(os.listdir(PCOG))
        if files:
            img = Image.open(os.path.join(PCOG, files[-1])).convert("RGBA")
            img = crop_alpha(rf(img, 500, 650))
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 280), img)
    elif "aes" in p:
        files = sorted(os.listdir(PAES))
        if files:
            img = Image.open(os.path.join(PAES, files[-1])).convert("RGBA")
            img = crop_alpha(img)
            img = rf(img, 400, 550)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 300), img)

    tx(d, "DARK LUXURY", 540, 1150, fl(60,True), (180,80,100,200))
    tx(d, p.upper() + "  #peachtattoo", 540, 1310, fl(18), (140,110,110,200))

    fn = f"test_D_{p}.png"
    c.save(os.path.join(OUT, fn))
    print(f"  [D] {fn}")

def style_E(p, idx):
    c = Image.new("RGBA", (1080,1350))
    grad(c, (250,250,252), (235,235,240))
    d = ImageDraw.Draw(c)

    logo(c)
    tx(d, "PEACH", 120, 38, fl(48,True), (40,40,45,250))
    tx(d, "PREMIUM TATTOO CARTRIDGE", 120, 90, fl(18), (120,120,130,200))

    for x in range(0, 1080, 120):
        d.line([(x,200),(x,1150)], fill=(200,200,210,15), width=1)
    for y in range(200, 1150, 120):
        d.line([(0,y),(1080,y)], fill=(200,200,210,15), width=1)

    pe(c, "ring_pink_md.png", 900, 500)

    if "aes" in p:
        img = load_img(PAES)
        if img:
            img = crop_alpha(img)
            img = rf(img, 550, 650)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 250), img)
            ink_tip(c, cx+img.width//2, 290, "pink")
    elif "con" in p:
        img = load_img(PCON, "438")
        if img:
            img = crop_alpha(img)
            img = rf(img, 400, 600)
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 300), img)
    elif "cog" in p:
        img = load_img(PCOG)
        if img:
            img = crop_alpha(rf(img, 500, 600))
            cx = (1080 - img.width)//2
            c.paste(img, (cx, 260), img)

    tx(d, "CLEAN PRECISION", 540, 1150, fl(56,True), (40,40,45,180))
    tx(d, p.upper() + "  #peachtattoo", 540, 1310, fl(18), (120,120,130,200))

    fn = f"test_E_{p}.png"
    c.save(os.path.join(OUT, fn))
    print(f"  [E] {fn}")

# ============================================================
# MAIN
# ============================================================
print("=" * 60)
print("  PEACH 5-STYLE TEST GENERATOR (15 images + ink)")
print("=" * 60)

styles = [
    (style_A, ["con", "cog", "aes"]),
    (style_B, ["aes", "con", "cog"]),
    (style_C, ["con", "cog", "hand"]),
    (style_D, ["con", "cog", "aes"]),
    (style_E, ["aes", "con", "cog"]),
]

for style_fn, products in styles:
    print()
    for i, p in enumerate(products):
        style_fn(p, i)

print(f"\nDone! -> {OUT}")
