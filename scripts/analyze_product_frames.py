"""
Product Visual Protocol Analyzer — batch analysis for product still images.

Usage:
  python scripts/analyze_product_frames.py
  python scripts/analyze_product_frames.py --brands bigwasp.official,kwadron
  python scripts/analyze_product_frames.py --delay 3.0 --output data/product_analysis.json
"""

import argparse
import base64
import concurrent.futures
import json
import os
import sys
import time
import urllib.request

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PROJECT_ROOT)

from analyzer.dictionary_loader import load_all_dictionaries

# ── Paths ──
PRODUCT_PROMPT    = os.path.join(PROJECT_ROOT, "prompts", "product_analysis_prompt.txt")
PRODUCT_SCHEMA    = os.path.join(PROJECT_ROOT, "schemas", "product_schema.json")
PRODUCT_PROTOCOL  = os.path.join(PROJECT_ROOT, "products", "product_visual_protocol.json")
SCENE_PROTOCOL    = os.path.join(PROJECT_ROOT, "taxonomy", "scene_construction_protocol.json")
REASONING_RULES   = os.path.join(PROJECT_ROOT, "prompts", "reasoning_rules.json")
FRAMES_DIR       = os.path.join(PROJECT_ROOT, "data", "hook_frames")
PRODUCT_IMG_DIR  = os.path.join(PROJECT_ROOT, "data", "product_images")
OUTPUT_FILE      = os.path.join(PROJECT_ROOT, "data", "product_analysis.json")
DEFAULT_DELAY    = 2.0

# ── API Config ──
def _load_dotenv():
    env_path = os.path.join(PROJECT_ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip()
                if key not in os.environ:
                    os.environ[key] = val

_load_dotenv()

API_KEY     = os.getenv("SILICON_KEY") or os.getenv("OPENAI_API_KEY")
BASE_URL    = os.getenv("VISION_BASE_URL", "https://api.siliconflow.cn/v1")
MODEL       = os.getenv("VISION_MODEL", "Qwen/Qwen3-VL-32B-Instruct")
API_TIMEOUT = int(os.getenv("VISION_TIMEOUT", "180"))

# ── Helper: encode image ──
def encode_image(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

# ── Helper: call vision API ──
def call_vision_api(prompt, b64_img):
    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Analyze this tattoo product image."},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}}
                ]
            }
        ],
        "temperature": 0.3
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}"
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=API_TIMEOUT) as resp:
        result = json.loads(resp.read())
    return result["choices"][0]["message"]["content"]

# ── Build product analysis prompt ──
def build_product_prompt():
    # Load text prompt
    with open(PRODUCT_PROMPT, "r", encoding="utf-8") as f:
        prompt_base = f.read()

    # Load schema
    with open(PRODUCT_SCHEMA, "r", encoding="utf-8") as f:
        schema = json.load(f)

    # Load standard dictionaries
    dicts = load_all_dictionaries()

    # Load reasoning rules and extract possible values for fine-grained fields
    reasoning_values = {}  # domain_prefix -> set of possible values
    if os.path.exists(REASONING_RULES):
        with open(REASONING_RULES, "r", encoding="utf-8") as f:
            reasoning = json.load(f)
        for domain, domain_data in reasoning.get("rules", {}).items():
            prefix = domain.replace("_inference", "").replace("_identification_rules", "").replace("_prompt_assembly", "")
            vals = set()
            for rule in domain_data.get("rules", []):
                for inf in rule.get("inference", []):
                    v = inf.get("value", "")
                    if v: vals.add(v)
            for fine in domain_data.get("coarse_to_fine_mapping", {}).values():
                for v in fine.values():
                    if v: vals.add(v)
            reasoning_values[prefix] = sorted(vals)
            reasoning_values[domain] = sorted(vals)  # also register full name

    # Load product protocol
    with open(PRODUCT_PROTOCOL, "r", encoding="utf-8") as f:
        protocol = json.load(f)

    # Build dictionary listing (only relevant ones for product)
    relevant_dicts = ["camera_terms", "lighting_terms", "composition_terms",
                      "materials_terms", "content_types", "visual_styles",
                      "product_categories", "style_terms",
                      "motion_terms", "physical_realism_terms",
                      "needle_type_terms", "needle_gauge_terms",
                      "needle_taper_terms", "cartridge_color_terms",
                      "membrane_type_terms", "connection_type_terms",
                      "packaging_format_terms", "brand_prediction_terms",
                      "flow_channel_terms", "internal_taper_terms",
                      "needle_count_terms"]
    dict_lines = []
    for name in relevant_dicts:
        if name in dicts:
            vals = dicts[name]
            if isinstance(vals, list):
                dict_lines.append(f"\n{name.upper()}:")
                for v in vals:
                    dict_lines.append(f"  - {v}")

    # Build product protocol listing
    proto_categories = protocol.get("categories", {})
    proto_lines = []
    for cat_name, cat_data in proto_categories.items():
        proto_lines.append(f"\n{cat_name.upper()} ({cat_data.get('description','')}):")
        for term in cat_data.get("terms", []):
            proto_lines.append(f"  - {term}")

    # Load scene construction protocol
    scene_lines = []
    if os.path.exists(SCENE_PROTOCOL):
        with open(SCENE_PROTOCOL, "r", encoding="utf-8") as f:
            scene = json.load(f)
        modules = scene.get("modules", {})
        for mod_name, mod_data in modules.items():
            desc = mod_data.get("description", "")
            scene_lines.append(f"\n{mod_name.upper()} ({desc}):")
            terms = mod_data.get("terms", [])
            subfields = mod_data.get("subfields", {})
            if terms:
                for term in terms:
                    scene_lines.append(f"  - {term}")
            if subfields:
                for sf_name, sf_terms in subfields.items():
                    scene_lines.append(f"  [{sf_name}]:")
                    for st in sf_terms:
                        scene_lines.append(f"    - {st}")

    # Load reasoning rules
    reasoning_lines = []
    if os.path.exists(REASONING_RULES):
        with open(REASONING_RULES, "r", encoding="utf-8") as f:
            reasoning = json.load(f)
        rules = reasoning.get("rules", {})
        for domain, domain_data in rules.items():
            desc = domain_data.get("description", "")
            reasoning_lines.append(f"\n{domain.upper()}: {desc}")
            # Add visual cues
            cues = domain_data.get("visual_cues_priority", [])
            if cues:
                reasoning_lines.append("  Visual cues to examine:")
                for cue in cues:
                    reasoning_lines.append(f"    - {cue}")
            # Add per-field inference rules
            for rule in domain_data.get("rules", []):
                field = rule.get("field", "")
                field_desc = rule.get("description", "")
                reasoning_lines.append(f"\n  {field} ({field_desc}):")
                for inf in rule.get("inference", []):
                    reasoning_lines.append(f'    IF "{inf.get("condition","")}" → {inf.get("value","")}')
            # Add coarse-to-fine mapping table (first 5 entries as examples)
            c2f = domain_data.get("coarse_to_fine_mapping", {})
            if c2f:
                reasoning_lines.append(f"\n  Coarse-to-Fine mapping examples:")
                for coarse, fine in list(c2f.items())[:5]:
                    fine_str = "; ".join(f"{k}={v}" for k, v in fine.items())
                    reasoning_lines.append(f'    "{coarse}" -> {fine_str}')

    # Product category list
    target_products = protocol.get("target_products", [])
    target_lines = [f"  - {p}" for p in target_products]

    # ── Build explicit field→allowed-values mapping ──
    def _get_terms(dict_name):
        if dict_name.startswith("reasoning_"):
            prefix = dict_name.replace("reasoning_", "", 1)
            return reasoning_values.get(prefix, [])
        elif dict_name.startswith("product_") and dict_name != "product_categories":
            cat = protocol.get("categories", {}).get(dict_name.replace("product_", "", 1), {})
            return cat.get("terms", [])
        elif dict_name.startswith("scene_"):
            mod = scene.get("modules", {}).get(dict_name.replace("scene_", "", 1), {})
            terms = list(mod.get("terms", []))
            for sf in mod.get("subfields", {}).values():
                terms.extend(sf)
            return terms
        else:
            vals = dicts.get(dict_name, [])
            if isinstance(vals, list):
                return vals
            elif isinstance(vals, dict):
                result = []
                for key, val in vals.items():
                    result.append(key)  # include category key name
                    if isinstance(val, list):
                        result.extend(val)
                    elif isinstance(val, dict):
                        for sub in val.values():
                            if isinstance(sub, list):
                                result.extend(sub)
                return result
            return []

    field_value_lines = []
    for field, dict_name in FIELD_TO_DICT.items():
        terms = _get_terms(dict_name)
        if terms:
            field_value_lines.append(f"  {field}: {', '.join(terms)}")

    # Assemble final prompt
    full_prompt = f"""
{prompt_base}

========================
STANDARD DICTIONARIES
========================

{chr(10).join(dict_lines)}

========================
TARGET PRODUCT TYPES
========================

{chr(10).join(target_lines)}

========================
PRODUCT VISUAL PROTOCOL
========================

{chr(10).join(proto_lines)}

========================
SCENE CONSTRUCTION PROTOCOL
========================

{chr(10).join(scene_lines)}

========================
VISUAL REASONING RULES
========================

{chr(10).join(reasoning_lines)}

========================
FIELD ALLOWED VALUES (use these exact values per field)
========================

{chr(10).join(field_value_lines)}

========================
OUTPUT SCHEMA
========================

{json.dumps(schema, indent=2)}

========================
STRICT RULES
========================

- Output JSON only, no markdown, no explanations
- For each field, pick a value from its ALLOWED VALUES list above
- Every field must be filled — do NOT use "" or leave empty
- Only use "unknown" as last resort if no value fits
- For fine-grained fields (lighting_fine, position_fine, etc.), use the reasoning rules to infer values from visual evidence
"""
    return full_prompt

# ── Extract JSON from model output ──
def extract_json(raw):
    raw = raw.strip()
    # Try to find JSON between ```json and ``` markers
    if "```json" in raw:
        raw = raw.split("```json")[1].split("```")[0].strip()
    elif "```" in raw:
        raw = raw.split("```")[1].split("```")[0].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Try to find first { and last }
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start:end+1])
            except json.JSONDecodeError:
                return None
        return None

# ── Build allowed set from dictionaries + protocol ──
def build_allowed_set(dicts, protocol):
    allowed = {}
    # Standard dictionaries
    for name, values in dicts.items():
        terms = set()
        if isinstance(values, list):
            for v in values:
                if isinstance(v, str):
                    terms.add(v.lower())
        elif isinstance(values, dict):
            for key, val in values.items():
                terms.add(key.lower())  # include category key name
                if isinstance(val, list):
                    for item in val:
                        if isinstance(item, str):
                            terms.add(item.lower())
                elif isinstance(val, dict):
                    for sub in val.values():
                        if isinstance(sub, list):
                            for item in sub:
                                if isinstance(item, str):
                                    terms.add(item.lower())
        allowed[name] = terms

    # Product protocol categories
    categories = protocol.get("categories", {})
    for cat_name, cat_data in categories.items():
        terms = set()
        for term in cat_data.get("terms", []):
            terms.add(term.lower())
            # Also add term name without description (for model outputs)
            name_only = term.split(" —")[0].split(" –")[0].strip().lower()
            if name_only:
                terms.add(name_only)
        allowed[f"product_{cat_name}"] = terms

    # Scene construction protocol modules
    try:
        with open(SCENE_PROTOCOL, "r", encoding="utf-8") as f:
            scene = json.load(f)
        modules = scene.get("modules", {})
        for mod_name, mod_data in modules.items():
            terms = set()
            for term in mod_data.get("terms", []):
                terms.add(term.lower())
                name_only = term.split(" —")[0].split(" –")[0].strip().lower()
                if name_only:
                    terms.add(name_only)
            subfields = mod_data.get("subfields", {})
            for sf_name, sf_terms in subfields.items():
                for st in sf_terms:
                    terms.add(st.lower())
                    name_only = st.split(" —")[0].split(" –")[0].strip().lower()
                    if name_only:
                        terms.add(name_only)
            allowed[f"scene_{mod_name}"] = terms
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Reasoning rules — extract inference values for fine-grained fields
    try:
        with open(REASONING_RULES, "r", encoding="utf-8") as f:
            reasoning = json.load(f)
        rules = reasoning.get("rules", {})
        for domain, domain_data in rules.items():
            domain_terms = set()
            # Extract from per-field inference rules
            for rule in domain_data.get("rules", []):
                for inf in rule.get("inference", []):
                    val = inf.get("value", "")
                    if val:
                        domain_terms.add(val.lower())
            # Extract from coarse-to-fine mapping values
            for fine_values in domain_data.get("coarse_to_fine_mapping", {}).values():
                for v in fine_values.values():
                    if v:
                        domain_terms.add(v.lower())
            if domain_terms:
                allowed[f"reasoning_{domain.replace('_inference','').replace('_identification_rules','').replace('_prompt_assembly','')}"] = domain_terms
                # Also register with the full domain name for fallback
                allowed[f"reasoning_{domain}"] = domain_terms
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    return allowed

# ── Field validation ──
FIELD_TO_DICT = {
    "camera.shot_type": "camera_terms",
    "camera.camera_angle": "camera_terms",
    "camera.focus_style": "camera_terms",
    "camera.lens_feeling": "camera_terms",
    "camera.depth_of_field": "camera_terms",
    "lighting.lighting_style": "lighting_terms",
    "lighting.contrast_level": "lighting_terms",
    "lighting.shadow_density": "lighting_terms",
    "lighting.lighting_direction": "lighting_terms",
    "lighting.temperature_feeling": "lighting_terms",
    "composition.framing_style": "composition_terms",
    "composition.subject_focus": "composition_terms",
    "composition.negative_space": "composition_terms",
    "composition.balance_style": "composition_terms",
    "materials.skin_texture": "materials_terms",
    "materials.glove_texture": "materials_terms",
    "materials.ink_reflection": "materials_terms",
    "materials.plastic_reflection": "materials_terms",
    "materials.metal_reflection": "materials_terms",
    "content_type": "content_types",
    "visual_style": "visual_styles",
    "product_category": "product_categories",
    "style_keywords": "style_terms",
    "product_scene.product_position": "product_product_position",
    "product_scene.background_style": "product_background_style",
    "product_scene.surface_type": "product_background_style",
    "product_scene.material_behavior": "product_material_behavior",
    "product_scene.camera_style": "product_camera_style",
    "product_scene.composition_style": "product_composition_style",
    "product_scene.desk_surface": "scene_desk_surface",
    "product_scene.desk_cover": "scene_desk_cover",
    "product_scene.tool_layout": "scene_tool_layout",
    "product_scene.contamination_level": "scene_contamination_level",
    "product_scene.workflow_state": "scene_workflow_state",
    "spatial_realism.foreground_obstruction": "scene_spatial_realism",
    "spatial_realism.partial_visibility": "scene_spatial_realism",
    "spatial_realism.cropped_objects": "scene_spatial_realism",
    "spatial_realism.depth_layering": "scene_spatial_realism",
    "spatial_realism.focus_falloff": "scene_spatial_realism",

    # ── Fine-grained fields (from reasoning rules, open-text values) ──
    "lighting_fine.light_direction": "reasoning_lighting",
    "lighting_fine.light_hardness": "reasoning_lighting",
    "lighting_fine.light_count": "reasoning_lighting",
    "lighting_fine.contrast_level": "reasoning_lighting",
    "lighting_fine.temperature_feeling": "reasoning_lighting",
    "position_fine.product_angle": "reasoning_position",
    "position_fine.distance": "reasoning_position",
    "position_fine.framing": "reasoning_position",
    "position_fine.perspective": "reasoning_position",
    "material_fine.specular_intensity": "reasoning_material",
    "material_fine.surface_roughness": "reasoning_material",
    "material_fine.material_category": "reasoning_material",
    "camera_fine.focal_length_equivalent": "reasoning_camera",
    "camera_fine.aperture_feeling": "reasoning_camera",
    "camera_fine.camera_movement_style": "reasoning_camera",
    "composition_fine.visual_weight_distribution": "reasoning_composition",
    "composition_fine.depth_construction": "reasoning_composition",
    "composition_fine.negative_space_ratio": "reasoning_composition",
    "background_fine.background_material": "reasoning_background",
    "background_fine.background_depth": "reasoning_background",

    # ── Needle / Cartridge detail fields (per-field dictionaries) ──
    "needle_detail.needle_type": "needle_type_terms",
    "needle_detail.needle_gauge": "needle_gauge_terms",
    "needle_detail.needle_count": "needle_count_terms",
    "needle_detail.needle_taper": "needle_taper_terms",
    "needle_detail.cartridge_color": "cartridge_color_terms",
    "needle_detail.membrane_type": "membrane_type_terms",
    "needle_detail.connection_type": "connection_type_terms",
    "needle_detail.packaging_format": "packaging_format_terms",
    "needle_detail.brand_prediction": "brand_prediction_terms",
    "needle_detail.flow_channel_visible": "flow_channel_terms",
    "needle_detail.internal_taper_visible": "internal_taper_terms",
}

def validate_field(value, allowed_set):
    if isinstance(value, str):
        return value if value.lower() in allowed_set else "unknown"
    elif isinstance(value, list):
        return [v if v.lower() in allowed_set else "unknown" for v in value]
    return value

def validate_analysis(data, allowed_set):
    for field, dict_name in FIELD_TO_DICT.items():
        allowed = allowed_set.get(dict_name, set())
        if "." not in field:
            if field in data:
                data[field] = validate_field(data[field], allowed)
        else:
            section, subfield = field.split(".", 1)
            if section in data and isinstance(data[section], dict):
                if subfield in data[section]:
                    data[section][subfield] = validate_field(data[section][subfield], allowed)
    return data

# ── Get brand directories ──
def get_brand_dirs(source, brands_filter=None):
    if source == "product_images":
        if not os.path.exists(PRODUCT_IMG_DIR):
            print(f"ERROR: dir not found: {PRODUCT_IMG_DIR}")
            sys.exit(1)
        all_files = sorted(os.listdir(PRODUCT_IMG_DIR))
        imgs = sorted([f for f in all_files if f.lower().endswith((".jpg", ".png", ".jpeg"))])
        if imgs:
            return [("peach_supply", PRODUCT_IMG_DIR, imgs)]
        return []

    # hook_frames mode (default)
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

# ── Main ──
def main():
    parser = argparse.ArgumentParser(description="Batch analyze product images")
    parser.add_argument("--brands", help="Comma-separated brand dirs (default: all)")
    parser.add_argument("--source", choices=["product_images", "hook_frames"], default="product_images",
                        help="Source directory: hook_frames (brand subdirs) or product_images (flat)")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY, help=f"Delay between API calls (default: {DEFAULT_DELAY}s)")
    parser.add_argument("--output", default=OUTPUT_FILE, help="Output JSON path")
    parser.add_argument("--resume", action="store_true", help="Skip already-analyzed frames")
    args = parser.parse_args()

    brands_filter = set(args.brands.split(",")) if args.brands else None
    delay = max(0.5, args.delay)
    output_path = args.output

    source = args.source or "hook_frames"

    # Pre-build prompt and allowed set
    print("Building product analysis prompt...")
    prompt = build_product_prompt()

    dicts = load_all_dictionaries()
    with open(PRODUCT_PROTOCOL, "r", encoding="utf-8") as f:
        protocol = json.load(f)
    allowed_set = build_allowed_set(dicts, protocol)

    # Scan brands
    brands = get_brand_dirs(source, brands_filter)
    if not brands:
        print("No brand directories found.")
        return

    total_frames = sum(len(jpgs) for _, _, jpgs in brands)
    print(f"Found {len(brands)} brands, {total_frames} total frames\n")

    # Load existing results for resume
    existing = {}
    if args.resume and os.path.exists(output_path):
        with open(output_path, "r", encoding="utf-8") as f:
            existing = json.load(f)

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

            if args.resume and frame_key in results.get(brand_name, {}):
                if results[brand_name][frame_key].get("status") == "ok":
                    skipped += 1
                    print(f"  SKIP {jpg}")
                    continue

            img_path = os.path.join(brand_path, jpg)
            print(f"  [{processed+1}/{total_frames}] {brand_name}/{jpg}...", end=" ", flush=True)

            try:
                b64 = encode_image(img_path)

                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(call_vision_api, prompt, b64)
                    raw = future.result(timeout=240)

                parsed = extract_json(raw)
                if parsed is None:
                    results[brand_name][frame_key] = {
                        "status": "error", "error": "parse_failed", "image": jpg
                    }
                    failed += 1
                    print("PARSE_FAILED")
                else:
                    validated = validate_analysis(parsed, allowed_set)
                    results[brand_name][frame_key] = {
                        "status": "ok", "image": jpg, "analysis": validated
                    }
                    ct = validated.get("content_type", "?")
                    print(f"{ct}")

            except Exception as e:
                results[brand_name][frame_key] = {
                    "status": "error", "error": str(e)[:200], "image": jpg
                }
                failed += 1
                print(f"ERROR: {str(e)[:60]}")

            processed += 1

            if processed % 5 == 0:
                tmp = output_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(results, f, indent=2, ensure_ascii=False)
                os.replace(tmp, output_path)

            if processed < total_frames:
                time.sleep(delay)

    # Final save
    tmp = output_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    os.replace(tmp, output_path)

    print(f"\n{'='*50}")
    print(f"  DONE: {processed} processed, {skipped} skipped, {failed} failed")
    print(f"  Results: {output_path}")
    print(f"{'='*50}")

if __name__ == "__main__":
    main()
