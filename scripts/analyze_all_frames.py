"""
Batch analysis: runs the Peach AI structured analyzer on all hook_frames.

Usage:
  python scripts/analyze_all_frames.py
  python scripts/analyze_all_frames.py --brands cheyenne_tattooequipment,kwadron
  python scripts/analyze_all_frames.py --delay 3.0
"""

import argparse
import concurrent.futures
import json
import os
import sys
import time

# Ensure project root is on path
PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from analyzer.gpt_vision_analyzer import analyze_image
from analyzer.dictionary_loader import load_all_dictionaries
from validators.tag_normalizer import normalize_json

FRAMES_DIR = os.path.join(PROJECT_ROOT, "data", "hook_frames")
OUTPUT_FILE = os.path.join(PROJECT_ROOT, "data", "peach_analysis.json")  # may be overridden in main()
DEFAULT_DELAY = 2.0  # seconds between API calls to avoid rate limiting

def get_brand_dirs(brands_filter=None):
    """Scan hook_frames/ for brand directories with .jpg files."""
    if not os.path.exists(FRAMES_DIR):
        print(f"ERROR: frames dir not found: {FRAMES_DIR}")
        sys.exit(1)

    brands = []
    for entry in sorted(os.listdir(FRAMES_DIR)):
        entry_path = os.path.join(FRAMES_DIR, entry)
        if os.path.isdir(entry_path):
            jpgs = sorted([f for f in os.listdir(entry_path) if f.lower().endswith(".jpg")])
            if jpgs:
                brands.append((entry, entry_path, jpgs))

    if brands_filter:
        brands = [b for b in brands if b[0] in brands_filter]

    return brands

def load_existing_results():
    """Load existing results for resume support."""
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_results(results):
    """Atomic save with temp file."""
    tmp = OUTPUT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    os.replace(tmp, OUTPUT_FILE)

def main():
    parser = argparse.ArgumentParser(description="Batch analyze hook frames with Peach AI pipeline")
    parser.add_argument("--brands", help="Comma-separated brand dirs to process (default: all)")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY, help=f"Seconds between API calls (default: {DEFAULT_DELAY})")
    parser.add_argument("--resume", action="store_true", help="Skip already-analyzed frames")
    parser.add_argument("--strategy", action="store_true", help="Use strategy analysis instead of technical analysis")
    args = parser.parse_args()

    brands_filter = set(args.brands.split(",")) if args.brands else None
    delay = max(0.5, args.delay)
    mode = "strategy" if args.strategy else "technical"

    global OUTPUT_FILE
    if args.strategy:
        OUTPUT_FILE = os.path.join(PROJECT_ROOT, "data", "brand_strategy.json")

    brands = get_brand_dirs(brands_filter)
    if not brands:
        print("No brand directories with .jpg files found.")
        return

    total_frames = sum(len(jpgs) for _, _, jpgs in brands)
    print(f"Found {len(brands)} brands, {total_frames} total frames\n")

    # Load existing results for resume
    existing = load_existing_results() if args.resume else {}

    results = existing.copy()
    processed = 0
    skipped = 0
    failed = 0

    for brand_name, brand_path, jpgs in brands:
        print(f"\n{'='*50}")
        print(f"  {brand_name} ({len(jpgs)} frames)")
        print(f"{'='*50}")

        if brand_name not in results:
            results[brand_name] = {}

        for jpg in jpgs:
            frame_key = jpg.replace(".jpg", "")

            # Resume: skip if already analyzed successfully
            if args.resume and frame_key in results[brand_name]:
                existing_entry = results[brand_name][frame_key]
                if existing_entry.get("status") == "ok":
                    skipped += 1
                    print(f"  SKIP {jpg} (already analyzed)")
                    continue

            img_path = os.path.join(brand_path, jpg)
            print(f"  [{processed+1}/{total_frames}] {brand_name}/{jpg}...", end=" ", flush=True)

            try:
                # Run each image with a timeout so one slow API call can't hang the batch
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(analyze_image, img_path, mode)
                    result = future.result(timeout=240)

                if result is None:
                    results[brand_name][frame_key] = {
                        "status": "error",
                        "error": "parse_failed",
                        "image": jpg
                    }
                    failed += 1
                    print("PARSE_FAILED")
                else:
                    results[brand_name][frame_key] = {
                        "status": "ok",
                        "image": jpg,
                        "analysis": result
                    }
                    content_type = result.get("post_purpose") or result.get("content_type") or result.get("contentType", "?")
                    product_cat = result.get("product_category", result.get("productCategory", ""))
                    confidence = "?"
                    # extract a rough confidence/summary
                    print(f"{content_type}{f' [{product_cat}]' if product_cat else ''}")
            except Exception as e:
                results[brand_name][frame_key] = {
                    "status": "error",
                    "error": str(e)[:200],
                    "image": jpg
                }
                failed += 1
                print(f"ERROR: {str(e)[:60]}")

            processed += 1

            # Periodic save every 5 frames
            if processed % 5 == 0:
                save_results(results)

            # Rate limit delay
            if processed < total_frames:
                time.sleep(delay)

    # Final save
    save_results(results)

    print(f"\n{'='*50}")
    print(f"  DONE: {processed} processed, {skipped} skipped, {failed} failed")
    print(f"  Results: {OUTPUT_FILE}")
    print(f"{'='*50}")

if __name__ == "__main__":
    main()
