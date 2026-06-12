"""
Image Processor — Fal.ai Flux + IP-Adapter image-to-image pipeline
For Peach brand: generate styled product images from competitor reference screenshots.

Usage:
  # Basic: style transfer from a reference image
  python image-processor.py --input product.png --ref competitor.png --output out.png --product-line main

  # Batch: generate N variants
  python image-processor.py --input product.png --ref competitor.png --output out.png --product-line main --count 3

  # Multi-reference: mix multiple competitor styles
  python image-processor.py --input product.png --ref ref1.png ref2.png --output out.png --product-line men

  # Dry run: print prompt only
  python image-processor.py --input product.png --ref competitor.png --product-line pmu --dry-run

Requirements:
  - fal-client installed (pip install fal-client)
  - FAL_KEY environment variable set
  - Input images as absolute paths
  - Reference images in style_rules/reference_images/peach/

Product Lines:
  - main (主线粉绿): Pink + Green palette
  - men (Men灰白): Grey + White palette
  - pmu (PMU粉透明): Pink + Transparent palette

Brand Colors (product anchor injection):
  main: pink silicone ring, green collar, white frosted housing
  men: grey silicone ring, white housing, black accents
  pmu: pink translucent housing, clear connector
"""
import argparse
import json
import os
import sys
import time
import base64
import io
from pathlib import Path

# ── Config ──
PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
STYLE_RULES_DIR = os.path.join(PROJECT_ROOT, "style_rules")
REFERENCE_DIR = os.path.join(STYLE_RULES_DIR, "reference_images", "peach")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "output", "peach_ink_cup")

# ── Product Line Color Palettes ──
PRODUCT_PALETTES = {
    "main": {
        "name": "主线粉绿",
        "colors": "pink and green color scheme",
        "features": "pink silicone ring with PEACH logo, green plastic collar, white frosted translucent housing",
        "bg": "soft pink to white gradient",
        "mood": "fresh, premium, feminine",
    },
    "men": {
        "name": "Men灰白",
        "colors": "grey and white color scheme, cool tones",
        "features": "grey silicone ring with PEACH logo, white housing, black metal accents",
        "bg": "dark grey gradient",
        "mood": "masculine, modern, bold",
    },
    "pmu": {
        "name": "PMU粉透明",
        "colors": "pink and transparent color scheme",
        "features": "pink translucent housing, clear connector showing needle, soft pink accents",
        "bg": "soft white to light pink gradient",
        "mood": "professional, delicate, clinical-chic",
    },
}

# ── Composition Modes (rotate for variety) ──
COMPOSITION_MODES = [
    "floating center composition, product suspended in space",
    "45-degree angled shot, product viewed from upper right",
    "flat lay top-down, product centered on background",
    "needle macro close-up, extreme detail on needle tip",
    "hand-held lifestyle, product in gloved artist hand",
    "product group shot, multiple cartridges arranged artistically",
    "detail detail ring shot, focus on silicone ring and logo",
]


def log(msg):
    print(f"[image-processor] {msg}", flush=True)


def load_style_index():
    """Load style_index.json for competitor style references."""
    style_idx_path = os.path.join(STYLE_RULES_DIR, "style_index.json")
    if os.path.exists(style_idx_path):
        with open(style_idx_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def find_reference_images(brand="peach"):
    """Find available reference images for a brand."""
    brand_dir = os.path.join(REFERENCE_DIR, brand) if "peach" in brand else os.path.join(REFERENCE_DIR, brand)
    ref_dir = os.path.join(REFERENCE_DIR, brand)
    if not os.path.exists(ref_dir):
        return []
    refs = []
    for f in sorted(os.listdir(ref_dir)):
        if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            refs.append(os.path.join(ref_dir, f))
    return refs


def build_prompt(product_line, composition_idx, style_brand="kwadron"):
    """
    Build the natural language prompt using the formula:
    [Angle/Composition] + [Light] + [Material] + [Background] + [Contrast] + [Mood]
    Plus product anchor + color palette.
    """
    palette = PRODUCT_PALETTES.get(product_line, PRODUCT_PALETTES["main"])
    comp = COMPOSITION_MODES[composition_idx % len(COMPOSITION_MODES)]

    # Style brand lighting cues
    style_cues = {
        "kwadron": "hard light from upper left creating sharp highlights on metallic edges, precise industrial aesthetic, cool tones with rim lighting",
        "tatsoul": "soft diffused lighting, dark textured background, muted low saturation, authentic tattoo culture vibe",
        "world_famous": "intense commercial hard lighting, pure matte black background, ultra-saturated colors with gold accents, maximum luminance contrast",
        "peach_custom": "professional studio lighting with triple light sources (key, fill, rim), shallow depth of field, texture contrast between matte and glossy surfaces",
    }
    lighting = style_cues.get(style_brand, style_cues["peach_custom"])

    prompt = (
        f"{comp}, {lighting}, "
        f"tattoo cartridge product, {palette['features']}, "
        f"{palette['colors']}, "
        f"{palette['bg']}, "
        f"professional product photography, "
        f"{palette['mood']}, "
        f"photorealistic, 8K detail, commercial quality"
    )

    return prompt


def build_negative_prompt():
    return (
        "blurry, distorted, deformed, ugly, bad anatomy, watermark, text overlay, "
        "low quality, cartoon, plastic, fake, medical equipment, syringe, "
        "oversaturated, low resolution, bad proportions, "
        "generic product cliches, floating on white with drop shadow"
    )


def encode_image_to_base64(image_path):
    """Encode a local image to base64 string for Fal.ai API."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def call_fal_ip_adapter(image_path, image_prompt_paths, prompt, negative_prompt,
                        product_line, num_images=1, guidance_scale=3.5,
                        num_inference_steps=30, output_format="png"):
    """
    Call Fal.ai flux/ip-adapter generate endpoint.
    
    Args:
        image_path: input product/base image (local path)
        image_prompt_paths: list of reference image paths for style (local paths)
        prompt: text description
        negative_prompt: what to avoid
        product_line: main/men/pmu
        num_images: 1-4
        guidance_scale: 3.5 for balanced style+product adherence
        num_inference_steps: 28-50
        output_format: png or webp
    
    Returns:
        list of output image file paths
    """
    import fal_client

    log(f"Uploading input image: {image_path}")
    # Upload input image
    input_img_handle = fal_client.upload_file(image_path)

    # Upload reference images (image_prompt for IP-Adapter)
    ref_handles = []
    for i, ref_path in enumerate(image_prompt_paths):
        log(f"Uploading reference {i+1}/{len(image_prompt_paths)}: {ref_path}")
        ref_handles.append(fal_client.upload_file(ref_path))

    # Compose the full prompt with product anchor
    palette = PRODUCT_PALETTES.get(product_line, PRODUCT_PALETTES["main"])
    full_prompt = (
        f"{prompt} | Product: tattoo cartridge with {palette['features']}, "
        f"{palette['colors']}. Keep product shape exactly as shown in input image."
    )

    log(f"Calling Fal.ai flux/ip-adapter...")
    log(f"  Prompt: {full_prompt[:150]}...")
    log(f"  Guidance: {guidance_scale}, Steps: {num_inference_steps}")
    log(f"  Num images: {num_images}")

    result = fal_client.run(
        "fal-ai/flux/ip-adapter",
        arguments={
            "image": input_img_handle,
            "image_prompt": ref_handles,
            "prompt": full_prompt,
            "negative_prompt": negative_prompt,
            "num_images": num_images,
            "output_format": output_format,
            "guidance_scale": guidance_scale,
            "num_inference_steps": num_inference_steps,
        },
    )

    return result


def save_output(result, product_line, output_dir, variant_idx=0):
    """Save generated image(s) to output directory."""
    os.makedirs(output_dir, exist_ok=True)

    saved = []
    timestamp = int(time.time())

    # Handle different response formats
    images = []
    if "images" in result:
        images = result["images"]
    elif "data" in result:
        images = result["data"]
        # Some versions return list of dicts with url/b64_json
        if images and isinstance(images[0], dict):
            if "b64_json" in images[0]:
                # Already base64
                for img_data in images:
                    images.append({"b64_json": img_data["b64_json"]})
            elif "url" in images[0]:
                pass  # keep as-is
        elif images:
            # Might be list of dicts already
            pass

    if not images:
        log(f"Unexpected result format: {json.dumps(result, indent=2)[:500]}")
        return saved

    for i, img in enumerate(images):
        filename = f"{product_line}_{timestamp}_v{i}.png"
        filepath = os.path.join(output_dir, filename)

        if "url" in img and img["url"]:
            # Download from URL
            import urllib.request
            req = urllib.request.Request(img["url"])
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            with open(filepath, "wb") as f:
                f.write(data)
        elif "b64_json" in img and img["b64_json"]:
            data = base64.b64decode(img["b64_json"])
            with open(filepath, "wb") as f:
                f.write(data)
        else:
            log(f"  Skipping image entry without url/b64_json: {img}")
            continue

        size_kb = os.path.getsize(filepath) // 1024
        log(f"  Saved: {filepath} ({size_kb}KB)")
        saved.append(filepath)

    return saved


def main():
    parser = argparse.ArgumentParser(
        description="Fal.ai Flux + IP-Adapter image processor for Peach brand"
    )
    parser.add_argument("--input", required=True, help="Input product image path")
    parser.add_argument("--ref", nargs="+", default=[],
                        help="Reference image path(s) for IP-Adapter style transfer. "
                             "Omit to auto-detect from style_rules/reference_images/peach/")
    parser.add_argument("--output", required=True, help="Output directory or file path")
    parser.add_argument("--product-line", default="main", choices=["main", "men", "pmu"],
                        help="Peach product line: main (粉绿), men (灰白), pmu (粉透明)")
    parser.add_argument("--count", type=int, default=1, help="Number of images to generate")
    parser.add_argument("--composition", type=int, default=0,
                        help="Composition mode index (0-6), rotates for variety")
    parser.add_argument("--style-brand", default="peach_custom",
                        choices=["kwadron", "tatsoul", "world_famous", "peach_custom"],
                        help="Competitor style to use as base")
    parser.add_argument("--guidance-scale", type=float, default=3.5,
                        help="IP-Adapter guidance scale (3.0-5.0, default 3.5)")
    parser.add_argument("--steps", type=int, default=30,
                        help="Inference steps (28-50, default 30)")
    parser.add_argument("--format", default="png", choices=["png", "webp"],
                        help="Output format")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print prompt and exit without generating")
    parser.add_argument("--auto-ref", action="store_true",
                        help="Auto-detect reference images from style_rules/")

    args = parser.parse_args()

    # Resolve paths
    args.input = os.path.abspath(args.input)
    args.output = os.path.abspath(args.output)

    # Create output dir
    output_dir = args.output if os.path.splitext(args.output)[1] else args.output
    os.makedirs(output_dir, exist_ok=True)

    # Find reference images
    image_prompt_paths = args.ref if args.ref else []
    if args.auto_ref or (not image_prompt_paths):
        refs = find_reference_images()
        if refs:
            image_prompt_paths = refs
            log(f"Auto-detected {len(refs)} reference images")
        else:
            log("WARNING: No reference images found. "
                "Place competitor screenshots in style_rules/reference_images/peach/")
            log("Using text-only mode (IP-Adapter style transfer will be weaker).")

    # Generate prompts
    negative_prompt = build_negative_prompt()
    prompts = []
    for i in range(args.count):
        prompt = build_prompt(args.product_line, args.composition + i, args.style_brand)
        prompts.append(prompt)

    # Dry run
    if args.dry_run:
        log("=" * 60)
        log("DRY RUN — No images generated")
        log(f"Product line: {args.product_line} "
            f"({PRODUCT_PALETTES[args.product_line]['name']})")
        log(f"Style brand: {args.style_brand}")
        log(f"Reference images: {len(image_prompt_paths)}")
        log(f"Negative prompt: {negative_prompt[:80]}...")
        for i, p in enumerate(prompts):
            log(f"Prompt {i+1}: {p[:120]}...")
        log("=" * 60)
        return

    # Check API key
    if not os.environ.get("FAL_KEY"):
        log("ERROR: FAL_KEY environment variable not set.")
        log("Get your key from https://fal.ai/dashboard/keys")
        log("Set it: export FAL_KEY='your-key-here'  (Linux/Mac)")
        log("Set it: $env:FAL_KEY='your-key-here'  (PowerShell)")
        sys.exit(1)

    # Call Fal.ai
    for i in range(args.count):
        prompt = prompts[i]
        comp_idx = args.composition + i
        log(f"\n{'='*60}")
        log(f"Generating image {i+1}/{args.count} "
            f"[{PRODUCT_PALETTES[args.product_line]['name']}] "
            f"[Composition {comp_idx % len(COMPOSITION_MODES)}]")
        log(f"Prompt: {prompt[:120]}...")

        try:
            result = call_fal_ip_adapter(
                image_path=args.input,
                image_prompt_paths=image_prompt_paths,
                prompt=prompt,
                negative_prompt=negative_prompt,
                product_line=args.product_line,
                num_images=1,  # one at a time for progress tracking
                guidance_scale=args.guidance_scale,
                num_inference_steps=args.steps,
                output_format=args.format,
            )

            # Save output
            if args.output and not os.path.splitext(args.output)[1]:
                saved = save_output(result, args.product_line, args.output, variant_idx=i)
            else:
                saved = [args.output]
                # Try to save inline
                if result.get("images"):
                    img = result["images"][0]
                    out_path = args.output
                    if "url" in img:
                        import urllib.request
                        req = urllib.request.Request(img["url"])
                        with urllib.request.urlopen(req, timeout=120) as resp:
                            data = resp.read()
                        with open(out_path, "wb") as f:
                            f.write(data)
                        log(f"Saved: {out_path}")
                    elif "b64_json" in img:
                        data = base64.b64decode(img["b64_json"])
                        with open(out_path, "wb") as f:
                            f.write(data)
                        log(f"Saved: {out_path}")

            log(f"Done: {saved}")

            # Wait between generations
            if i < args.count - 1:
                log("Waiting 5s before next generation...")
                time.sleep(5)

        except Exception as e:
            log(f"FAIL: {e}")
            import traceback
            traceback.print_exc()
            continue

    log(f"\n{'='*60}")
    log("All done!")
    log("=" * 60)


if __name__ == "__main__":
    main()
