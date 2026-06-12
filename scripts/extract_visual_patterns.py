"""
Extract Visual Patterns — converts frame-level analysis into brand-level visual DNA.

Reads peach_analysis.json → outputs brand_visual_dna.json

Usage:
  python scripts/extract_visual_patterns.py
  python scripts/extract_visual_patterns.py --input data/peach_analysis.json --output data/brand_visual_dna.json
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from analyzer.dictionary_loader import load_all_dictionaries


def load_analysis(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def flatten_field(obj, prefix=""):
    """Yield (field_path, value) pairs from nested analysis dict."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            fp = f"{prefix}.{k}" if prefix else k
            yield from flatten_field(v, fp)
    elif isinstance(obj, list):
        for item in obj:
            yield (prefix, item)
    else:
        yield (prefix, obj)


def build_dna_from_frames(frames, brand_name):
    """Build visual DNA from a dict of frame analyses for one brand."""
    ok_frames = [e for e in frames.values() if e.get("status") == "ok"]
    analyses = [e["analysis"] for e in ok_frames]

    if not analyses:
        return {"status": "no_ok_frames", "frame_count": len(frames)}

    # Collect all field values
    field_counter = defaultdict(Counter)

    # Score accumulators
    authenticity_scores = defaultdict(list)
    social_scores = defaultdict(list)

    for a in analyses:
        for path, value in flatten_field(a):
            if value and value not in ("unknown", "", [], {}):
                field_counter[path][str(value)] += 1

        # Scores
        ta = a.get("tattoo_authenticity", {})
        for k in ("realism_score", "documentary_feeling_score", "commercial_feeling_score", "studio_authenticity_score"):
            v = ta.get(k)
            if v is not None:
                authenticity_scores[k].append(v)

        sm = a.get("social_media", {})
        for k in ("hook_strength", "retention_potential", "viral_potential", "conversion_potential"):
            v = sm.get(k)
            if v is not None:
                social_scores[k].append(v)

    # Build top-N for each field section
    def top_n(counter_key, n=5):
        return [{"value": v, "count": c} for v, c in field_counter.get(counter_key, Counter()).most_common(n)]

    def avg(scores_list):
        return round(sum(scores_list) / len(scores_list), 1) if scores_list else 0

    # Content type distribution
    content_types = field_counter.get("content_type", Counter())

    # Visual style distribution
    visual_styles = field_counter.get("visual_style", Counter())

    # Build generation-ready synthesis (most common keywords)
    gen_img = field_counter.get("generation_ready.image_prompt_keywords", Counter())
    gen_vid = field_counter.get("generation_ready.video_prompt_keywords", Counter())

    # Style keywords
    style_kws = field_counter.get("style_keywords", Counter())

    # Build the DNA
    dna = {
        "brand": brand_name,
        "frame_count_ok": len(analyses),
        "frame_count_total": len(frames),

        "content_dna": {
            "dominant_type": content_types.most_common(1)[0][0] if content_types else "unknown",
            "type_distribution": {k: v for k, v in content_types.most_common()},
        },

        "visual_dna": {
            "dominant_style": visual_styles.most_common(1)[0][0] if visual_styles else "unknown",
            "style_distribution": {k: v for k, v in visual_styles.most_common()},

            "top_camera": {
                "shot_types": top_n("camera.shot_type"),
                "camera_angles": top_n("camera.camera_angle"),
                "camera_movements": top_n("camera.camera_movement"),
                "focus_styles": top_n("camera.focus_style"),
                "lens_feelings": top_n("camera.lens_feeling"),
                "depth_of_field": top_n("camera.depth_of_field"),
            },
            "top_lighting": {
                "lighting_styles": top_n("lighting.lighting_style"),
                "contrast_levels": top_n("lighting.contrast_level"),
                "shadow_densities": top_n("lighting.shadow_density"),
                "lighting_directions": top_n("lighting.lighting_direction"),
                "temperature_feelings": top_n("lighting.temperature_feeling"),
            },
            "top_composition": {
                "framing_styles": top_n("composition.framing_style"),
                "subject_focus": top_n("composition.subject_focus"),
                "negative_spaces": top_n("composition.negative_space"),
                "balance_styles": top_n("composition.balance_style"),
            },
            "top_materials": {
                "skin_textures": top_n("materials.skin_texture"),
                "glove_textures": top_n("materials.glove_texture"),
                "ink_reflections": top_n("materials.ink_reflection"),
                "plastic_reflections": top_n("materials.plastic_reflection"),
                "metal_reflections": top_n("materials.metal_reflection"),
            },
            "top_motion": {
                "motion_types": top_n("motion.motion_type"),
                "camera_motions": top_n("motion.camera_motion"),
                "speed_feelings": top_n("motion.speed_feeling"),
                "vibration_feelings": top_n("motion.vibration_feeling"),
            },

            "top_style_keywords": top_n("style_keywords", 10),
        },

        "product_dna": {
            "product_categories": top_n("product_category"),
        },

        "score_dna": {
            "authenticity": {k: avg(v) for k, v in authenticity_scores.items()},
            "social_potential": {k: avg(v) for k, v in social_scores.items()},
        },

        "generation_dna": {
            "top_image_keywords": top_n("generation_ready.image_prompt_keywords", 15),
            "top_video_keywords": top_n("generation_ready.video_prompt_keywords", 15),
        },
    }

    # Unique visual signature
    all_signals = []
    for section in ["camera", "lighting", "composition"]:
        for subfield, entries in dna["visual_dna"][f"top_{section}" if section != "camera" else "top_camera"].items():
            if isinstance(entries, list) and entries:
                top_val = entries[0]["value"]
                if entries[0]["count"] >= len(analyses) * 0.3:  # appears in 30%+ of frames
                    all_signals.append(f"{section}.{subfield}={top_val}")

    dna["visual_signature"] = " | ".join(all_signals[:8])

    return dna


def build_cross_brand_insights(all_dna):
    """Compare brands and extract cross-brand patterns."""
    if len(all_dna) < 2:
        return {}

    insights = {}

    # Highest and lowest conversion by brand
    conversions = {}
    for brand, dna in all_dna.items():
        scores = dna.get("score_dna", {}).get("social_potential", {})
        conversions[brand] = scores.get("conversion_potential", 0)

    if conversions:
        insights["highest_conversion"] = max(conversions, key=conversions.get)
        insights["lowest_conversion"] = min(conversions, key=conversions.get)

    # Most common visual style across brands
    style_counter = Counter()
    for brand, dna in all_dna.items():
        for style, count in dna.get("visual_dna", {}).get("style_distribution", {}).items():
            style_counter[style] += count

    if style_counter:
        insights["industry_dominant_style"] = style_counter.most_common(1)[0][0]

    # Content type leaders
    type_counter = Counter()
    for brand, dna in all_dna.items():
        for ct, count in dna.get("content_dna", {}).get("type_distribution", {}).items():
            type_counter[ct] += count

    if type_counter:
        insights["industry_dominant_content"] = type_counter.most_common(1)[0][0]

    return insights


def main():
    parser = argparse.ArgumentParser(description="Extract brand visual DNA from frame analysis")
    parser.add_argument("--input", default="data/peach_analysis.json",
                        help="Input analysis JSON (default: data/peach_analysis.json)")
    parser.add_argument("--output", default="data/brand_visual_dna.json",
                        help="Output DNA JSON (default: data/brand_visual_dna.json)")
    args = parser.parse_args()

    input_path = os.path.join(PROJECT_ROOT, args.input) if not os.path.isabs(args.input) else args.input
    output_path = os.path.join(PROJECT_ROOT, args.output) if not os.path.isabs(args.output) else args.output

    if not os.path.exists(input_path):
        print(f"ERROR: input not found: {input_path}")
        sys.exit(1)

    print(f"Loading analysis: {input_path}")
    data = load_analysis(input_path)

    all_dna = {}
    for brand_name, frames in data.items():
        print(f"  Processing {brand_name} ({len(frames)} frames)...")
        dna = build_dna_from_frames(frames, brand_name)
        all_dna[brand_name] = dna

    # Cross-brand insights
    cross_insights = build_cross_brand_insights(all_dna)

    output = {
        "generated_at": "2026-05-27",
        "total_brands": len(all_dna),
        "total_frames": sum(d.get("frame_count_total", 0) for d in all_dna.values()),
        "cross_brand_insights": cross_insights,
        "brands": all_dna,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nVisual DNA extracted: {output_path}")
    print(f"  Brands: {len(all_dna)}")
    print(f"  Total frames: {output['total_frames']}")

    # Quick summary
    for brand, dna in all_dna.items():
        vd = dna.get("visual_dna", {})
        cd = dna.get("content_dna", {})
        sig = dna.get("visual_signature", "")
        print(f"  {brand}: {cd.get('dominant_type','?')} | {vd.get('dominant_style','?')} | {sig}")


if __name__ == "__main__":
    main()
