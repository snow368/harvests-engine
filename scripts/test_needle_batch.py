"""
Quick test — run 20 needle product images through vision pipeline.
Usage: python scripts/test_needle_batch.py
"""
import json, os, sys, time, base64, urllib.request
from concurrent.futures import ThreadPoolExecutor, TimeoutError

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PROJECT_ROOT)

from analyzer.dictionary_loader import load_all_dictionaries
from scripts.analyze_product_frames import (
    build_product_prompt, build_allowed_set, extract_json,
    validate_analysis, PRODUCT_PROTOCOL, FIELD_TO_DICT
)

TEST_DIR = os.path.join(PROJECT_ROOT, "data", "test_needle_batch")
OUTPUT = os.path.join(PROJECT_ROOT, "data", "test_needle_batch_results.json")

API_KEY = os.getenv("SILICON_KEY")
BASE_URL = os.getenv("VISION_BASE_URL", "https://api.siliconflow.cn/v1")
MODEL = os.getenv("VISION_MODEL", "Qwen/Qwen3-VL-32B-Instruct")

def call_vision(prompt, b64_img):
    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": [
                {"type": "text", "text": "Analyze this tattoo needle/cartridge product image."},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}}
            ]}
        ],
        "temperature": 0.3
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions", data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        result = json.loads(resp.read())
    return result["choices"][0]["message"]["content"]

def encode_image(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

def main():
    print("Building prompt + allowed set...")
    prompt = build_product_prompt()
    dicts = load_all_dictionaries()
    with open(PRODUCT_PROTOCOL, "r", encoding="utf-8") as f:
        protocol = json.load(f)
    allowed_set = build_allowed_set(dicts, protocol)

    images = sorted([f for f in os.listdir(TEST_DIR) if f.lower().endswith((".jpg", ".png", ".jpeg"))])
    print(f"Found {len(images)} images in test_needle_batch/\n")

    results = {}
    for i, img in enumerate(images):
        path = os.path.join(TEST_DIR, img)
        print(f"[{i+1}/{len(images)}] {img}...", end=" ", flush=True)
        try:
            b64 = encode_image(path)

            # Retry logic for timeout errors
            for attempt in range(3):
                try:
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        future = pool.submit(call_vision, prompt, b64)
                        raw = future.result(timeout=300)
                    break
                except (TimeoutError, urllib.error.URLError) as e:
                    if attempt < 2:
                        print(f"\n  RETRY {attempt+1} after {e!s}", flush=True)
                        time.sleep(5)
                        continue
                    raise

            parsed = extract_json(raw)
            if parsed is None:
                results[img] = {"status": "error", "error": "parse_failed"}
                print("PARSE_FAILED")
            else:
                validated = validate_analysis(parsed, allowed_set)
                results[img] = {"status": "ok", "analysis": validated}
                # Show key needle fields
                nd = validated.get("needle_detail", {})
                ct = validated.get("content_type", "?")
                pc = validated.get("product_category", "?")
                nd_type = nd.get("needle_type", "?")
                brand = nd.get("brand_prediction", "?")
                gauge = nd.get("needle_gauge", "?")
                cnt = nd.get("needle_count", "?")
                taper = nd.get("needle_taper", "?")
                flow = nd.get("flow_channel_visible", "?")
                itaper = nd.get("internal_taper_visible", "?")
                memb = nd.get("membrane_type", "?")
                conn = nd.get("connection_type", "?")
                color = nd.get("cartridge_color", "?")
                print(f"type={nd_type} gauge={gauge} cnt={cnt} taper={taper} brand={brand} memb={memb} conn={conn} flow={flow} taper_inside={itaper} color={color}")
        except Exception as e:
            results[img] = {"status": "error", "error": str(e)[:200]}
            print(f"ERROR: {str(e)[:60]}")

        # Save incrementally
        tmp = OUTPUT + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        os.replace(tmp, OUTPUT)

        if i < len(images) - 1:
            time.sleep(1.5)

    # Summary
    ok = sum(1 for v in results.values() if v["status"] == "ok")
    err = sum(1 for v in results.values() if v["status"] == "error")
    print(f"\n{'='*50}")
    print(f"  DONE: {ok} ok, {err} error")
    print(f"  Results: {OUTPUT}")
    print(f"{'='*50}")

    # Needle detail summary table
    print("\n--- Needle Detail Summary ---")
    for img, r in results.items():
        if r["status"] != "ok":
            print(f"\n{img}: ERROR - {r.get('error','?')}")
            continue
        a = r.get("analysis", {})
        nd = a.get("needle_detail", {})
        print(f"\n{img}:")
        for k, v in nd.items():
            if v and v != "unknown":
                print(f"  {k}: {v}")

if __name__ == "__main__":
    main()
