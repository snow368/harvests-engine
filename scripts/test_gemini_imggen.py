"""
Peach 图生图 — 用 Qwen-Image-Edit (SiliconFlow)
上传产品图，AI 保持产品不变，按风格描述换背景/布光

用法:
  python scripts/test_gemini_imggen.py                     # 默认
  python scripts/test_gemini_imggen.py --dry-run            # 只看提示词
  python scripts/test_gemini_imggen.py --style dark         # 预设风格
  python scripts/test_gemini_imggen.py --style flatlay      # 俯拍风
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
env_path = os.path.join(PROJECT_ROOT, '.env')
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

API_KEY = os.environ.get("SILICON_KEY", "")
BASE_URL = "https://api.siliconflow.cn/v1"
MODEL = "Qwen/Qwen-Image-Edit-2509"
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "data", "generated_samples")
os.makedirs(OUTPUT_DIR, exist_ok=True)

def p(text):
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode('utf-8', errors='replace').decode('gbk', errors='replace'))

def encode_image(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()

def find_image():
    for d in ["RL", "COG", "new_photos"]:
        dp = os.path.join(PROJECT_ROOT, "data", "peach_products", d)
        if os.path.isdir(dp):
            files = sorted([f for f in os.listdir(dp) if f.lower().endswith(('.png','.jpg','.jpeg'))])
            if files: return os.path.join(dp, files[0])
    return None

STYLE_PRESETS = {
    "default": "Change the background to a professional studio setting with soft gradient lighting, clean commercial product photography aesthetic",
    "dark": "Change the background to dark moody with dramatic rim lighting, high contrast, premium luxury product vibe",
    "flatlay": "Change the composition to a top-down flat lay on a clean marble surface, soft diffused lighting, minimalist product photography",
    "studio": "Keep the product exactly the same. Replace the background with a bright commercial studio backdrop, pure white with soft shadows",
    "macro": "Change to extreme macro perspective, shallow depth of field focusing on the cartridge tip, dark out-of-focus background",
    "warm": "Replace the background with a warm peach-tinted studio scene, soft golden hour style lighting, cozy professional atmosphere",
}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", help="Peach 产品图路径")
    parser.add_argument("--style", choices=list(STYLE_PRESETS.keys()), default="default",
                        help="预设风格")
    parser.add_argument("--custom-style", help="自定义编辑指令（覆盖预设）")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    img = args.image or find_image()
    if not img or not os.path.exists(img):
        p("[ERROR] 找不到产品图")
        sys.exit(1)

    edit_instruction = args.custom_style or STYLE_PRESETS.get(args.style, STYLE_PRESETS["default"])

    # Qwen-Image-Edit 的 prompt 是编辑指令，不是描述
    prompt = edit_instruction

    p(f"[Input]   {os.path.basename(img)}")
    p(f"[Model]   {MODEL}")
    p(f"[Style]   {args.style}")
    p(f"\n{'='*60}")
    p("[EDIT INSTRUCTION]")
    p(f"{'='*60}")
    p(prompt)
    p(f"{'='*60}")

    if args.dry_run:
        p("\n[dry-run] 不会调用 API")
        sys.exit(0)

    image_b64 = encode_image(img)
    p(f"\n[Upload]  {len(image_b64)//1024} KB")

    payload = {
        "model": MODEL,
        "image": f"data:image/jpeg;base64,{image_b64}",
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
    }

    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/images/generations",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
        method="POST",
    )

    p("[Call] 正在生成...")
    start = time.time()

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        p(f"\n[ERROR] HTTP {e.code}: {body}")
        sys.exit(1)
    except Exception as e:
        p(f"\n[ERROR] {e}")
        sys.exit(1)

    elapsed = time.time() - start

    img_data = None
    if "images" in result and len(result["images"]) > 0:
        url = result["images"][0].get("url", "")
        if url:
            req_img = urllib.request.Request(url)
            with urllib.request.urlopen(req_img, timeout=60) as r:
                img_data = r.read()
    elif "data" in result and len(result["data"]) > 0:
        item = result["data"][0]
        if "b64_json" in item:
            img_data = base64.b64decode(item["b64_json"])
        elif "url" in item:
            req_img = urllib.request.Request(item["url"])
            with urllib.request.urlopen(req_img, timeout=60) as r:
                img_data = r.read()

    if not img_data:
        p(f"\n[ERROR] 无图片数据: {json.dumps(result)[:300]}")
        sys.exit(1)

    ts = int(time.time())
    out = os.path.join(OUTPUT_DIR, f"peach_edit_{args.style}_{ts}.png")
    with open(out, "wb") as f:
        f.write(img_data)

    p(f"\n[DONE] {elapsed:.1f}s")
    p(f"  {os.path.relpath(out, PROJECT_ROOT)} ({len(img_data)//1024} KB)")

if __name__ == "__main__":
    main()
