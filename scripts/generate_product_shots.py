"""
Peach AI Image Generator — 通过 cayapi 调用 gpt-image-2 批量生图

配合 CompositionEngine 生成 prompt，自动出图存入 review 队列。

Usage:
  python scripts/generate_product_shots.py                    # 默认生成产品展示图
  python scripts/generate_product_shots.py --scene tattoo_cartridge --count 5
  python scripts/generate_product_shots.py --prompt "自定义prompt" --output my_folder
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PROJECT_ROOT)

# ── Image Gen Config (from .env, falls back to defaults) ──
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env'))

API_KEY = os.getenv("XIAOXINAI_API_KEY", "sk-42356131435560a95f673e2bc48503591144aa753ae1ee2093d57eb2ba72488a")
BASE_URL = os.getenv("XIAOXINAI_BASE_URL", "https://api.cayapi.top/v1")
MODEL = os.getenv("XIAOXINAI_MODEL", "gpt-image-2")

OUTPUT_DIR = os.path.join(PROJECT_ROOT, "data", "generated_samples")
os.makedirs(OUTPUT_DIR, exist_ok=True)

REVIEW_DIR = os.path.join(PROJECT_ROOT, "data", "review_queue")
os.makedirs(REVIEW_DIR, exist_ok=True)

# ── Preset scenes (use CompositionEngine or manual prompts) ──
SCENE_PROMPTS = {
    "tattoo_cartridge": (
        "Premium tattoo cartridge product photography, extreme macro close-up, "
        "soft peach pink plastic housing with brushed silver metal connector, "
        "commercial studio lighting with rim light, center composition, "
        "black gradient background, hyper realistic, 8K detail, "
        "professional tattoo supply product shot"
    ),
    "cartridge_detail": (
        "Ultra macro shot of tattoo cartridge needle tip, extreme close-up, "
        "sharp focus on needle grouping and membrane, "
        "brushed metal texture with chrome reflection, "
        "commercial product lighting, shallow depth of field, "
        "dark background, hyper realistic detail"
    ),
    "product_flat_lay": (
        "Flat lay photography of tattoo cartridge set, multiple cartridges arranged artistically, "
        "top-down view, soft diffused studio lighting, "
        "minimalist white background, clean commercial product photography, "
        "professional tattoo supply branding"
    ),
    "hand_held": (
        "Tattoo artist hand holding a premium tattoo cartridge, "
        "close-up shot, gloved hand, natural studio lighting, "
        "shallow depth of field focusing on the cartridge, "
        "clinical clean background, professional tattoo studio setting"
    ),
}

NEGATIVE = "blurry, distorted, deformed, ugly, bad anatomy, watermark, text overlay, low quality, cartoon, oversaturated, low resolution, bad proportions"


def generate_image(prompt, scene_name="custom", negative="", size="1024x1024"):
    """Call cayapi gpt-image-2 to generate an image."""
    payload = {
        "model": MODEL,
        "prompt": prompt,
        "n": 1,
        "size": size,
    }

    if negative:
        payload["negative_prompt"] = negative

    body = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        f"{BASE_URL}/images/generations",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"API HTTP {e.code}: {body}")
    except Exception as e:
        raise RuntimeError(f"API error: {e}")

    # Handle different response formats
    if "data" in result and len(result["data"]) > 0:
        image_url = result["data"][0].get("url") or result["data"][0].get("b64_json", "")
    elif "images" in result and len(result["images"]) > 0:
        image_url = result["images"][0].get("url", "")
    else:
        raise RuntimeError(f"Unexpected response format: {json.dumps(result)[:200]}")

    timestamp = int(time.time())
    filename = f"{scene_name}_{timestamp}.png"
    filepath = os.path.join(OUTPUT_DIR, filename)

    # Download image
    req_img = urllib.request.Request(image_url)
    with urllib.request.urlopen(req_img, timeout=60) as img_resp:
        img_data = img_resp.read()

    with open(filepath, "wb") as f:
        f.write(img_data)

    return filepath


def add_to_review_queue(filepath, prompt, scene_name):
    """Add generated image to review queue (JSON manifest)."""
    review_entry = {
        "image": filepath,
        "prompt": prompt,
        "scene": scene_name,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "status": "pending_review",
        "reviewed": False,
        "approved": None,
    }

    manifest_path = os.path.join(REVIEW_DIR, "review_queue.json")
    queue = []
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            queue = json.load(f)

    queue.append(review_entry)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(queue, f, indent=2, ensure_ascii=False)

    return review_entry


def main():
    parser = argparse.ArgumentParser(description="Generate product images via cayapi")
    parser.add_argument("--scene", choices=list(SCENE_PROMPTS.keys()) + ["custom"],
                        default="tattoo_cartridge", help="Scene type preset")
    parser.add_argument("--prompt", help="Custom prompt (overrides scene preset)")
    parser.add_argument("--count", type=int, default=1, help="Number of images to generate")
    parser.add_argument("--output", default=OUTPUT_DIR, help="Output directory")
    parser.add_argument("--review", action="store_true", help="Add to review queue")
    parser.add_argument("--size", default="1024x1024", choices=["1024x1024", "1792x1024", "1024x1792"],
                        help="Image size")
    args = parser.parse_args()

    # Determine prompt
    if args.prompt:
        prompt = args.prompt
        scene_name = "custom"
    elif args.scene != "custom":
        prompt = SCENE_PROMPTS[args.scene]
        scene_name = args.scene
    else:
        print("Error: specify --prompt or --scene")
        sys.exit(1)

    print(f"{'='*50}")
    print(f"  Peach Image Generator")
    print(f"  Model: {MODEL}")
    print(f"  Count: {args.count}")
    print(f"  Size:  {args.size}")
    print(f"{'='*50}")
    print(f"\nPrompt: {prompt[:100]}...")

    for i in range(args.count):
        print(f"\n  [{i+1}/{args.count}] Generating...", end=" ", flush=True)
        try:
            filepath = generate_image(prompt, scene_name, NEGATIVE, args.size)
            size_kb = os.path.getsize(filepath) // 1024
            print(f"OK -> {os.path.basename(filepath)} ({size_kb}KB)")

            if args.review:
                entry = add_to_review_queue(filepath, prompt, scene_name)
                print(f"         Added to review queue (id: pending)")

        except Exception as e:
            print(f"FAIL: {e}")
            continue

        if i < args.count - 1:
            time.sleep(3)

    print(f"\n{'='*50}")
    print(f"  Done. Images saved to {OUTPUT_DIR}")
    if args.review:
        print(f"  Review queue: {os.path.join(REVIEW_DIR, 'review_queue.json')}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
