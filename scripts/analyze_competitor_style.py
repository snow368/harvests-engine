"""
同行产品图风格分析 — 用百炼 qwen3-vl-flash
读取 content-library/products/ 的同行图，分析视觉风格 → 输出可复用的 prompt 模板

用法:
  python scripts/analyze_competitor_style.py
  python scripts/analyze_competitor_style.py --sample 5
  python scripts/analyze_competitor_style.py --dry-run
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error, re

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))

# 读 .env
env_path = os.path.join(PROJECT_ROOT, '.env')
if os.path.exists(env_path):
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

API_KEY = os.environ.get("BAILIAN_API_KEY", "")
MODEL = "qwen3-vl-flash"  # 最便宜，¥0.15/百万token输入
BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"

OUTPUT_DIR = os.path.join(PROJECT_ROOT, "data", "style_analysis")
os.makedirs(OUTPUT_DIR, exist_ok=True)

def p(text):
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode('utf-8', errors='replace').decode('gbk', errors='replace'))

def encode_image(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()

ANALYSIS_PROMPT = """Analyze this tattoo supply product photo's visual style. Extract the following in JSON format:

{
  "background": {"type": "solid color/gradient/studio/scene/etc", "dominant_colors": ["#hex1", "#hex2"]},
  "lighting": {"setup": "soft studio/hard rim/dramatic side/etc", "mood": "warm/cool/neutral"},
  "composition": "center placement/flat lay/macro close-up/angled/etc",
  "color_palette": "description of main colors used",
  "mood": "clinical clean/luxury premium/industrial dark/minimalist/etc",
  "product_placement": "floating/surface/held in hand/with props/etc",
  "camera_perspective": "eye-level/top-down/45-degree/macro/etc",
  "distinctive_style": ["trait1", "trait2"]
}

Only output the JSON, no other text."""

def analyze_image(image_b64):
    """Call Bailian qwen3-vl-flash for vision analysis."""
    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    {"type": "text", "text": ANALYSIS_PROMPT},
                ],
            }
        ],
        "max_tokens": 500,
        "temperature": 0.1,
    }

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())

    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")

    # Extract JSON from response
    cleaned = re.sub(r'```json\s*|\s*```', '', content).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {"raw": cleaned}

def find_images(source_dir, max_count):
    images = []
    for root, dirs, files in os.walk(source_dir):
        for f in sorted(files):
            if f.lower().endswith(('.png', '.jpg', '.jpeg')):
                images.append(os.path.join(root, f))
    return images[:max_count] if max_count else images

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="content-library/products",
                        help="同行图片目录")
    parser.add_argument("--sample", type=int, default=0,
                        help="分析多少张 (0=全部)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not API_KEY:
        p("[ERROR] BAILIAN_API_KEY 未设置")
        sys.exit(1)

    source_dir = os.path.join(PROJECT_ROOT, args.source)
    if not os.path.isdir(source_dir):
        p(f"[ERROR] 目录不存在: {source_dir}")
        sys.exit(1)

    images = find_images(source_dir, args.sample or 9999)
    p(f"[Source] {args.source}")
    p(f"[Found]  {len(images)} 张图")
    p(f"[Model]  {MODEL} (¥0.15/百万token)")

    if not images:
        sys.exit(1)

    for img in images[:5]:
        p(f"  · {os.path.basename(img)}")
    if len(images) > 5:
        p(f"  · ...还有{len(images)-5}张")

    if args.dry_run:
        sys.exit(0)

    # 分析
    analyses = []
    for i, img_path in enumerate(images, 1):
        p(f"\n[{i}/{len(images)}] {os.path.basename(img_path)}...",)
        try:
            img_b64 = encode_image(img_path)
            result = analyze_image(img_b64)
            if result:
                analyses.append({"file": os.path.basename(img_path), "analysis": result})
                bg = result.get("background", {}).get("type", "?")
                mood = result.get("mood", "?")
                p(f"  → {bg} | {mood}")
            else:
                p("  → 无返回")
        except urllib.error.HTTPError as e:
            p(f"  → HTTP {e.code}: {e.read().decode()[:200]}")
        except Exception as e:
            p(f"  → {e}")

        if i < len(images):
            time.sleep(0.5)

    # 保存原始分析
    ts = int(time.time())
    raw_path = os.path.join(OUTPUT_DIR, f"competitor_analysis_{ts}.json")
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump(analyses, f, indent=2, ensure_ascii=False)
    p(f"\n[Saved] {os.path.relpath(raw_path, PROJECT_ROOT)}")

    # 聚合 → 风格模板
    bg_types = {}
    moods = {}
    lighting_setups = {}
    compositions = {}
    perspectives = {}
    palettes = {}

    for item in analyses:
        a = item.get("analysis", {})
        if "raw" in a:
            continue
        bg = a.get("background", {}).get("type", "unknown")
        bg_types[bg] = bg_types.get(bg, 0) + 1
        mood = a.get("mood", "unknown")
        moods[mood] = moods.get(mood, 0) + 1
        ls = a.get("lighting", {}).get("setup", "unknown")
        lighting_setups[ls] = lighting_setups.get(ls, 0) + 1
        comp = a.get("composition", "unknown")
        compositions[comp] = compositions.get(comp, 0) + 1
        cam = a.get("camera_perspective", "unknown")
        perspectives[cam] = perspectives.get(cam, 0) + 1

    def top(d, n=2):
        return [k for k, v in sorted(d.items(), key=lambda x: -x[1])[:n]]

    p(f"\n{'='*60}")
    p("[STYLE TEMPLATES]")
    p(f"{'='*60}")

    templates = {}
    for label, bg_filter in [("studio", "studio"), ("dark", "dark"), ("clean", "white")]:
        matched = [a for a in analyses if bg_filter in a.get("analysis", {}).get("background", {}).get("type", "").lower()]
        if matched:
            prompt = (
                f"Professional tattoo supply product photography. "
                f"Background: {top({k:1 for a in matched for k in [a['analysis'].get('background',{}).get('type','')]})[0]}. "
                f"Lighting: {top({a['analysis'].get('lighting',{}).get('setup',''):1 for a in matched})[0]}. "
                f"Mood: {top({a['analysis'].get('mood',''):1 for a in matched})[0]}. "
                f"Photorealistic, 8K detail, commercial quality, no text, no watermark."
            )
            templates[label] = {"count": len(matched), "prompt": prompt}
            p(f"\n--- {label} ({len(matched)}张) ---")
            p(f"  {prompt}")

    # 保存模板
    tmpl_path = os.path.join(OUTPUT_DIR, f"style_templates_{ts}.json")
    with open(tmpl_path, "w", encoding="utf-8") as f:
        json.dump({"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "total_analyzed": len(analyses),
                   "templates": templates}, f, indent=2, ensure_ascii=False)
    p(f"\n[Saved] {os.path.relpath(tmpl_path, PROJECT_ROOT)}")
    p(f"[Done]  分析 {len(analyses)} 张")

if __name__ == "__main__":
    main()
