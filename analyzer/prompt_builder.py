import json
import os

from dictionary_loader import load_all_dictionaries, load_all_taxonomies

BASE_DIR = os.path.dirname(os.path.dirname(__file__))

PROMPT_PATH = os.path.join(BASE_DIR, "prompts", "master_analysis_prompt.txt")
SCHEMA_PATH = os.path.join(BASE_DIR, "schemas", "analysis_schema.json")


def load_master_prompt():
    with open(PROMPT_PATH, "r", encoding="utf-8") as f:
        return f.read()


def load_schema():
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _render_dictionary(name, values):
    """Render a single dictionary as text lines."""
    lines = []
    if isinstance(values, dict):
        for key, val in values.items():
            if isinstance(val, dict) and "keywords" in val:
                kw = ", ".join(val["keywords"])
                lines.append(f"- {key} ({kw})")
            else:
                lines.append(f"- {key}: {val}")
    elif isinstance(values, list):
        for value in values:
            lines.append(f"- {value}")
    return "\n".join(lines)


STRATEGY_PROMPT_PATH = os.path.join(BASE_DIR, "prompts", "strategy_analysis_prompt.txt")
STRATEGY_SCHEMA_PATH = os.path.join(BASE_DIR, "schemas", "strategy_schema.json")


def load_strategy_prompt():
    with open(STRATEGY_PROMPT_PATH, "r", encoding="utf-8") as f:
        return f.read()


def load_strategy_schema():
    with open(STRATEGY_SCHEMA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


# Preload strategy prompt at module level for easy import
STRATEGY_PROMPT = load_strategy_prompt()


def build_analysis_prompt():

    master_prompt = load_master_prompt()
    schema = load_schema()
    dictionaries = load_all_dictionaries()
    taxonomies = load_all_taxonomies()

    # Build dictionary sections (categorized)
    dict_sections = []
    for name, values in dictionaries.items():
        rendered = _render_dictionary(name, values)
        dict_sections.append(f"\n{name.upper()}:\n{rendered}")

    # Build taxonomy sections (if any)
    taxonomy_sections = []
    for name, values in taxonomies.items():
        taxonomy_sections.append(f"\n{name.upper()}:")
        for category, info in values.items():
            if isinstance(info, dict) and "visual_indicators" in info:
                indicators = ", ".join(info["visual_indicators"])
                taxonomy_sections.append(f"- {category}: {indicators}")
            else:
                taxonomy_sections.append(f"- {category}: {info}")

    final_prompt = f"""
{master_prompt}

========================
DICTIONARIES (by field)
========================

{chr(10).join(dict_sections)}

========================
PRODUCT TAXONOMY
========================

{chr(10).join(taxonomy_sections) if taxonomy_sections else "(none)"}

========================
OUTPUT SCHEMA
========================

{json.dumps(schema, indent=2)}

========================
STRICT RULES
========================

- Output JSON only
- No markdown
- No explanations
- No invented labels
- Use only dictionary values
"""

    return final_prompt


if __name__ == "__main__":
    prompt = build_analysis_prompt()
    print(prompt)
