"""
Extract Product Visual Patterns — from product_analysis.json → brand_product_dna.json

Usage:
  python scripts/extract_product_patterns.py
  python scripts/extract_product_patterns.py --input data/product_analysis.json --output data/brand_product_dna.json
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PROJECT_ROOT)

from analyzer.dictionary_loader import load_all_dictionaries


def load_analysis(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def flatten_field(obj, prefix=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            fp = f"{prefix}.{k}" if prefix else k
            yield from flatten_field(v, fp)
    elif isinstance(obj, list):
        for item in obj:
            yield (prefix, item)
    else:
        yield (prefix, obj)


def build_dna(frames, brand_name):
    ok_frames = [e for e in frames.values() if e.get("status") == "ok"]
    analyses = [e["analysis"] for e in ok_frames]

    if not analyses:
        return {"status": "no_ok_frames", "frame_count": len(frames)}

    field_counter = defaultdict(Counter)
    authenticity_scores = defaultdict(list)
    social_scores = defaultdict(list)

    for a in analyses:
        for path, value in flatten_field(a):
            if value and value not in ("unknown", "", [], {}):
                field_counter[path][str(value)] += 1

        ta = a.get("tattoo_authenticity", {})
        for k in ("commercial_feeling_score", "studio_authenticity_score"):
            v = ta.get(k)
            if v is not None:
                authenticity_scores[k].append(v)

        sm = a.get("social_media", {})
        for k in ("hook_strength", "retention_potential", "viral_potential", "conversion_potential"):
            v = sm.get(k)
            if v is not None:
                social_scores[k].append(v)

    def top_n(counter_key, n=5):
        return [{"value": v, "count": c} for v, c in field_counter.get(counter_key, Counter()).most_common(n)]

    def avg(scores_list):
        return round(sum(scores_list) / len(scores_list), 1) if scores_list else 0

    content_types = field_counter.get("content_type", Counter())
    visual_styles = field_counter.get("visual_style", Counter())
    product_cats = field_counter.get("product_category", Counter())
    style_kws = field_counter.get("style_keywords", Counter())
    gen_img = field_counter.get("generation_ready.image_prompt_keywords", Counter())

    dna = {
        "brand": brand_name,
        "frame_count_ok": len(analyses),
        "frame_count_total": len(frames),

        "content_dna": {
            "dominant_type": content_types.most_common(1)[0][0] if content_types else "unknown",
            "type_distribution": {k: v for k, v in content_types.most_common()},
        },

        "product_dna": {
            "dominant_category": product_cats.most_common(1)[0][0] if product_cats else "unknown",
            "category_distribution": {k: v for k, v in product_cats.most_common()},
        },

        "visual_dna": {
            "dominant_style": visual_styles.most_common(1)[0][0] if visual_styles else "unknown",
            "style_distribution": {k: v for k, v in visual_styles.most_common()},
            "top_camera": {
                "shot_types": top_n("camera.shot_type"),
                "camera_angles": top_n("camera.camera_angle"),
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
            "top_style_keywords": top_n("style_keywords", 10),
        },

        "product_scene_dna": {
            "product_positions": top_n("product_scene.product_position"),
            "background_styles": top_n("product_scene.background_style"),
            "surface_types": top_n("product_scene.surface_type"),
            "material_behaviors": top_n("product_scene.material_behavior"),
            "camera_styles": top_n("product_scene.camera_style"),
            "composition_styles": top_n("product_scene.composition_style"),
            "desk_surfaces": top_n("product_scene.desk_surface"),
            "desk_covers": top_n("product_scene.desk_cover"),
            "tool_layouts": top_n("product_scene.tool_layout"),
            "contamination_levels": top_n("product_scene.contamination_level"),
            "workflow_states": top_n("product_scene.workflow_state"),
        },

        "spatial_realism_dna": {
            "foreground_obstructions": top_n("spatial_realism.foreground_obstruction"),
            "partial_visibilities": top_n("spatial_realism.partial_visibility"),
            "cropped_objects": top_n("spatial_realism.cropped_objects"),
            "depth_layerings": top_n("spatial_realism.depth_layering"),
            "focus_falloffs": top_n("spatial_realism.focus_falloff"),
        },

        "score_dna": {
            "authenticity": {k: avg(v) for k, v in authenticity_scores.items()},
            "social_potential": {k: avg(v) for k, v in social_scores.items()},
        },

        "generation_dna": {
            "top_image_keywords": top_n("generation_ready.image_prompt_keywords", 15),
        },

        "fine_grained_dna": {
            "lighting_fine": {
                "light_directions": top_n("lighting_fine.light_direction"),
                "light_hardnesses": top_n("lighting_fine.light_hardness"),
                "light_counts": top_n("lighting_fine.light_count"),
                "contrast_levels": top_n("lighting_fine.contrast_level"),
                "temperature_feelings": top_n("lighting_fine.temperature_feeling"),
            },
            "position_fine": {
                "product_angles": top_n("position_fine.product_angle"),
                "distances": top_n("position_fine.distance"),
                "framings": top_n("position_fine.framing"),
                "perspectives": top_n("position_fine.perspective"),
            },
            "material_fine": {
                "specular_intensities": top_n("material_fine.specular_intensity"),
                "surface_roughnesses": top_n("material_fine.surface_roughness"),
                "material_categories": top_n("material_fine.material_category"),
            },
            "camera_fine": {
                "focal_lengths": top_n("camera_fine.focal_length_equivalent"),
                "aperture_feelings": top_n("camera_fine.aperture_feeling"),
                "camera_movements": top_n("camera_fine.camera_movement_style"),
            },
            "composition_fine": {
                "weight_distributions": top_n("composition_fine.visual_weight_distribution"),
                "depth_constructions": top_n("composition_fine.depth_construction"),
                "negative_space_ratios": top_n("composition_fine.negative_space_ratio"),
            },
            "background_fine": {
                "background_materials": top_n("background_fine.background_material"),
                "background_depths": top_n("background_fine.background_depth"),
            },
        },
    }

    # Visual signature: dominant pattern across key dimensions
    signals = []
    for section_path, entries in [
        ("camera.shot_type", dna["visual_dna"]["top_camera"]["shot_types"]),
        ("lighting.lighting_style", dna["visual_dna"]["top_lighting"]["lighting_styles"]),
        ("composition.balance_style", dna["visual_dna"]["top_composition"]["balance_styles"]),
        ("product_scene.product_position", dna["product_scene_dna"]["product_positions"]),
        ("product_scene.desk_cover", dna["product_scene_dna"]["desk_covers"]),
        ("light_direction", dna["fine_grained_dna"]["lighting_fine"]["light_directions"]),
        ("product_angle", dna["fine_grained_dna"]["position_fine"]["product_angles"]),
    ]:
        if entries and entries[0]["count"] >= len(analyses) * 0.25:
            signals.append(f"{section_path.split('.')[-1]}={entries[0]['value']}")

    dna["visual_signature"] = " | ".join(signals[:6])
    return dna


def cross_brand_insights(all_dna):
    if len(all_dna) < 2:
        return {}

    insights = {}

    # Conversion leader
    conversions = {}
    for brand, dna in all_dna.items():
        scores = dna.get("score_dna", {}).get("social_potential", {})
        conversions[brand] = scores.get("conversion_potential", 0)
    if conversions:
        insights["highest_conversion_brand"] = max(conversions, key=conversions.get)

    # Most common visual style
    style_counter = Counter()
    for brand, dna in all_dna.items():
        for style, count in dna.get("visual_dna", {}).get("style_distribution", {}).items():
            style_counter[style] += count
    if style_counter:
        insights["industry_dominant_style"] = style_counter.most_common(1)[0][0]

    # Most common product position
    pos_counter = Counter()
    for brand, dna in all_dna.items():
        for entry in dna.get("product_scene_dna", {}).get("product_positions", []):
            pos_counter[entry["value"]] += entry["count"]
    if pos_counter:
        insights["industry_common_position"] = pos_counter.most_common(1)[0][0]

    # Most common desk cover
    cover_counter = Counter()
    for brand, dna in all_dna.items():
        for entry in dna.get("product_scene_dna", {}).get("desk_covers", []):
            cover_counter[entry["value"]] += entry["count"]
    if cover_counter:
        insights["industry_common_cover"] = cover_counter.most_common(1)[0][0]

    return insights


def main():
    parser = argparse.ArgumentParser(description="Extract brand product DNA from product analysis")
    parser.add_argument("--input", default="data/product_analysis.json", help="Input product analysis JSON")
    parser.add_argument("--output", default="data/brand_product_dna.json", help="Output DNA JSON")
    args = parser.parse_args()

    input_path = os.path.join(PROJECT_ROOT, args.input) if not os.path.isabs(args.input) else args.input
    output_path = os.path.join(PROJECT_ROOT, args.output) if not os.path.isabs(args.output) else args.output

    if not os.path.exists(input_path):
        print(f"ERROR: input not found: {input_path}")
        sys.exit(1)

    print(f"Loading product analysis: {input_path}")
    data = load_analysis(input_path)

    all_dna = {}
    for brand_name, frames in data.items():
        print(f"  Processing {brand_name} ({len(frames)} frames)...")
        dna = build_dna(frames, brand_name)
        all_dna[brand_name] = dna

    insights = cross_brand_insights(all_dna)

    output = {
        "generated_at": "2026-05-27",
        "total_brands": len(all_dna),
        "total_frames": sum(d.get("frame_count_total", 0) for d in all_dna.values()),
        "cross_brand_insights": insights,
        "brands": all_dna,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nProduct DNA extracted: {output_path}")
    print(f"  Brands: {len(all_dna)}")
    print(f"  Total frames: {output['total_frames']}")

    for brand, dna in all_dna.items():
        sig = dna.get("visual_signature", "?")
        cd = dna.get("content_dna", {})
        vd = dna.get("visual_dna", {})
        print(f"  {brand}: {cd.get('dominant_type','?')} | {vd.get('dominant_style','?')} | {sig}")


if __name__ == "__main__":
    main()
