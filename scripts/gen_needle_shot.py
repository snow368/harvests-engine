"""
Generate one in-action needle shot.
Usage: SILICON_KEY=xxx python scripts/gen_needle_shot.py
"""
import json, os, sys, urllib.request, urllib.error, base64, time

API_KEY = os.environ.get("SILICON_KEY")
if not API_KEY:
    print("Set SILICON_KEY env var")
    sys.exit(1)

MODEL = "Kwai-Kolors/Kolors"
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "generated_samples")
os.makedirs(OUT_DIR, exist_ok=True)

prompt = (
    "Tattoo needle cartridge piercing skin, macro extreme close-up, "
    "black ink flowing into skin from needle tip, "
    "realistic skin texture, shallow depth of field, "
    "branded tattoo cartridge visible, "
    "photorealistic documentary style, "
    "natural lighting, hyper detailed skin, "
    "ink spreading under skin, professional tattoo session"
)
neg = "blurry, distorted, deformed, ugly, bad anatomy, watermark, text, low quality, cartoon, plastic, fake"

body = json.dumps({"model": MODEL, "prompt": prompt, "negative_prompt": neg, "n": 1, "size": "1024x1024"}).encode()
req = urllib.request.Request(
    "https://api.siliconflow.cn/v1/images/generations",
    data=body,
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        result = json.loads(resp.read())
except urllib.error.HTTPError as e:
    msg = e.read().decode("utf-8", errors="replace")[:300]
    print(f"API error: {e.code} {msg}")
    sys.exit(1)

url = result["images"][0]["url"]
ts = int(time.time())
req_img = urllib.request.Request(url)
with urllib.request.urlopen(req_img, timeout=60) as r:
    data = r.read()

fp = os.path.join(OUT_DIR, f"needle_action_{ts}.png")
with open(fp, "wb") as f:
    f.write(data)
print(f"OK -> {fp} ({len(data)//1024}KB)")
