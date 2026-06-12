"""
Cross-field validator: checks each field's value against its allowed dictionary.
Replaces violations with "unknown" to enforce controlled vocabulary.
"""

import json
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from analyzer.dictionary_loader import load_all_dictionaries

# Map each schema field path → dictionary name
FIELD_TO_DICT = {
    # camera
    "camera.shot_type": "camera_terms",
    "camera.camera_angle": "camera_terms",
    "camera.camera_movement": "camera_terms",
    "camera.focus_style": "camera_terms",
    "camera.lens_feeling": "camera_terms",
    "camera.depth_of_field": "camera_terms",
    # lighting
    "lighting.lighting_style": "lighting_terms",
    "lighting.contrast_level": "lighting_terms",
    "lighting.shadow_density": "lighting_terms",
    "lighting.lighting_direction": "lighting_terms",
    "lighting.temperature_feeling": "lighting_terms",
    # composition
    "composition.framing_style": "composition_terms",
    "composition.subject_focus": "composition_terms",
    "composition.negative_space": "composition_terms",
    "composition.balance_style": "composition_terms",
    # materials
    "materials.skin_texture": "materials_terms",
    "materials.glove_texture": "materials_terms",
    "materials.ink_reflection": "materials_terms",
    "materials.plastic_reflection": "materials_terms",
    "materials.metal_reflection": "materials_terms",
    # motion
    "motion.motion_type": "motion_terms",
    "motion.camera_motion": "motion_terms",
    "motion.speed_feeling": "motion_terms",
    "motion.vibration_feeling": "motion_terms",
    # top-level
    "content_type": "content_types",
    "visual_style": "visual_styles",
    "product_category": "product_categories",
    "style_keywords": "style_terms",
}


def _build_allowed_set(dictionaries):
    """Build a dict of {dictionary_name: set(lowercase_values)}."""
    allowed = {}
    for name, values in dictionaries.items():
        terms = set()
        if isinstance(values, list):
            for v in values:
                if isinstance(v, str):
                    terms.add(v.lower())
        elif isinstance(values, dict):
            for key, val in values.items():
                terms.add(key.lower())
                if isinstance(val, dict) and "keywords" in val:
                    for kw in val["keywords"]:
                        terms.add(kw.lower())
        allowed[name] = terms
    return allowed


def validate_field(value, allowed_set):
    """Return value if allowed, else 'unknown'. Handles strings and lists."""
    if isinstance(value, str):
        return value if value.lower() in allowed_set else "unknown"
    elif isinstance(value, list):
        return [v if v.lower() in allowed_set else "unknown" for v in value]
    return value


def validate_analysis(data, allowed_set):
    """Validate a single analysis dict against allowed dictionaries."""
    # Top-level fields
    for field, dict_name in FIELD_TO_DICT.items():
        if "." not in field:
            allowed = allowed_set.get(dict_name, set())
            if field in data:
                data[field] = validate_field(data[field], allowed)

    # Nested fields (e.g. "camera.shot_type")
    sections = {}
    for field, dict_name in FIELD_TO_DICT.items():
        if "." in field:
            section, subfield = field.split(".", 1)
            if section not in sections:
                sections[section] = {}
            sections[section][subfield] = dict_name

    for section, subfields in sections.items():
        if section not in data or not isinstance(data[section], dict):
            continue
        for subfield, dict_name in subfields.items():
            allowed = allowed_set.get(dict_name, set())
            if subfield in data[section]:
                data[section][subfield] = validate_field(data[section][subfield], allowed)

    return data


def validate_batch(batch_data):
    """Validate entire peach_analysis.json result set."""
    dictionaries = load_all_dictionaries()
    allowed_set = _build_allowed_set(dictionaries)

    for brand, frames in batch_data.items():
        for key, entry in frames.items():
            if entry.get("status") != "ok":
                continue
            if "analysis" in entry:
                entry["analysis"] = validate_analysis(entry["analysis"], allowed_set)

    return batch_data


if __name__ == "__main__":
    # Test on the saved analysis
    path = os.path.join(PROJECT_ROOT, "data", "peach_analysis.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        data = validate_batch(data)
        # Count how many fields got corrected
        changes = 0
        for brand, frames in data.items():
            for key, entry in frames.items():
                if entry.get("status") != "ok":
                    continue
                a = entry["analysis"]
                for field, dict_name in FIELD_TO_DICT.items():
                    if "." not in field:
                        val = a.get(field, "")
                    else:
                        section, subfield = field.split(".", 1)
                        val = (a.get(section, {}) or {}).get(subfield, "")
                    if val == "unknown":
                        # Check if it was originally different
                        pass
        print("Validation complete. Use validate_batch() on your data.")
    else:
        print("No analysis file found.")
