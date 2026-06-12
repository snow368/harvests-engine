"""
Test image generation via SiliconFlow Kolors API.
Uses CompositionEngine to generate prompts, then generates images.
"""
import json, os, sys, time, urllib.request, urllib.error

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PROJECT_ROOT)

from analyzer.composition_engine import CompositionEngine

API_KEY = os.getenv("SILICON_KEY")
if not API_KEY:
    raise RuntimeError("SILICON_KEY env var not set")
BASE_URL = os.getenv("VISION_BASE_URL", "https://api.siliconflow.cn/v1")
MODEL = "Kwai-Kolors/Kolors"

OUTPUT_DIR = os.path.join(PROJECT_ROOT, "data", "generated_samples")
os.makedirs(OUTPUT_DIR, exist_ok=True)

def generate_image(prompt, scene_name, negative_prompt=""):
    body = {
        "model": MODEL,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
    }
    if negative_prompt:
        body["negative_prompt"] = negative_prompt
    payload = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        f"{BASE_URL}/images/generations",
        data=payload,
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
        body = e.read()
        msg = body.decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"SiliconFlow API HTTP {e.code}: {msg}")
    except Exception as e:
        raise RuntimeError(f"SiliconFlow API error: {e}")

    image_url = result["images"][0]["url"]
    timestamp = int(time.time())

    # Download image
    req_img = urllib.request.Request(image_url)
    with urllib.request.urlopen(req_img, timeout=60) as img_resp:
        img_data = img_resp.read()

    filename = f"{scene_name}_{timestamp}.png"
    filepath = os.path.join(OUTPUT_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(img_data)

    return filepath

def try_generate(scene, prompt, neg, label):
    print(f"\n--- {label} ---")
    print(f"Prompt: {prompt}")
    try:
        fp = generate_image(prompt, scene, neg)
        sz = os.path.getsize(fp)
        print(f"OK -> {fp} ({sz/1024:.0f}KB)")
        return fp
    except Exception as e:
        print(f"FAIL: {e}")
        return None

def main():
    engine = CompositionEngine()

    neg = "blurry, distorted, deformed, ugly, bad anatomy, watermark, text, low quality, cartoon, plastic, fake"

    # User wants: brand's cartridge in action — needle piercing skin with ink flow
    scene = "process_shot"
    print(f"\n{'='*60}")
    print(f"Scene: {scene}")

    result = engine.compose(scene)
    prompt = (
        f"Tattoo needle cartridge piercing skin, macro extreme close-up, "
        f"black ink flowing into skin from needle tip, "
        f"realistic skin texture, shallow depth of field, "
        f"branded tattoo cartridge visible, "
        f"photorealistic documentary style, "
        f"natural lighting, hyper detailed skin, "
        f"ink spreading under skin, professional tattoo session"
    )
    try_generate(scene, prompt, neg, "In-action needle shot")

    print(f"\nDone. Image saved to {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
