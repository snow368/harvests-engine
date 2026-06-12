"""Quick check: does the product prompt include all protocol terms?"""
import json, os, sys

PROJECT_ROOT = "F:/inkflow app/InkFlow_Project/inkflow_harvests"
sys.path.insert(0, PROJECT_ROOT)

from analyzer.dictionary_loader import load_all_dictionaries

prompt_path = os.path.join(PROJECT_ROOT, "prompts", "product_analysis_prompt.txt")
schema_path = os.path.join(PROJECT_ROOT, "schemas", "product_schema.json")
protocol_path = os.path.join(PROJECT_ROOT, "products", "product_visual_protocol.json")
scene_path = os.path.join(PROJECT_ROOT, "taxonomy", "scene_construction_protocol.json")

with open(prompt_path, "r", encoding="utf-8") as f:
    prompt_base = f.read()
with open(schema_path, "r", encoding="utf-8") as f:
    schema = json.load(f)
with open(protocol_path, "r", encoding="utf-8") as f:
    protocol = json.load(f)
with open(scene_path, "r", encoding="utf-8") as f:
    scene = json.load(f)

# Check protocol terms in schema
schema_fields = set()
def collect_fields(d, prefix=""):
    for k, v in d.items():
        fp = f"{prefix}.{k}" if prefix else k
        if isinstance(v, str):
            schema_fields.add(fp)
        elif isinstance(v, dict):
            collect_fields(v, fp)
collect_fields(schema)

# Check what protocol/scene terms are in prompt
full_text = prompt_base.lower()
with open(schema_path, "r", encoding="utf-8") as f:
    schema_text = f.read().lower()

all_text = full_text + schema_text

protocol_terms = protocol.get("categories", {})
for cat_name, cat_data in protocol_terms.items():
    for term in cat_data.get("terms", []):
        if term.lower()[:20] not in all_text:
            print(f"  MISSING from {cat_name}: {term[:50]}")

scene_modules = scene.get("modules", {})
for mod_name, mod_data in scene_modules.items():
    for term in mod_data.get("terms", []):
        if term.lower()[:20] not in all_text:
            print(f"  MISSING from scene.{mod_name}: {term[:50]}")
    for sf_name, sf_terms in mod_data.get("subfields", {}).items():
        for st in sf_terms:
            if st.lower()[:20] not in all_text:
                print(f"  MISSING from scene.{mod_name}.{sf_name}: {st[:50]}")

# Check schema fields
expected_scene_fields = [
    "product_scene.product_position", "product_scene.background_style",
    "product_scene.surface_type", "product_scene.material_behavior",
    "product_scene.desk_surface", "product_scene.desk_cover",
    "product_scene.tool_layout", "product_scene.contamination_level",
    "product_scene.workflow_state",
    "spatial_realism.foreground_obstruction", "spatial_realism.partial_visibility",
    "spatial_realism.cropped_objects", "spatial_realism.depth_layering",
    "spatial_realism.focus_falloff",
]
print("\n=== Schema field check ===")
for f in expected_scene_fields:
    if f in schema_fields:
        print(f"  OK: {f}")
    else:
        print(f"  MISSING: {f}")

print(f"\n=== Summary ===")
print(f"  Prompt base length: {len(prompt_base)} chars")
print(f"  Schema: {len(schema_fields)} fields")
print(f"  Protocol cats: {len(protocol_terms)}")
print(f"  Scene modules: {len(scene_modules)}")
