import base64
import json
import os
import sys
import urllib.request

# =========================
# LOAD .ENV (simple key=val parser for non-Node envs)
# =========================
def _load_dotenv():
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip()
                if key not in os.environ:
                    os.environ[key] = val

_load_dotenv()

# Ensure both the project root (for validators/) and the analyzer/
# directory itself are on sys.path, so imports work regardless of
# whether the file is run directly or imported as a module.
PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
ANALYZER_DIR = os.path.dirname(__file__)
for p in [PROJECT_ROOT, ANALYZER_DIR]:
    if p not in sys.path:
        sys.path.insert(0, p)

from prompt_builder import build_analysis_prompt, STRATEGY_PROMPT
from output_parser import extract_json

from validators.json_validator import (
    validate_json,
    autofix_json
)

from validators.tag_normalizer import (
    normalize_json
)

from validators.field_validator import (
    validate_analysis as validate_fields,
    FIELD_TO_DICT,
    _build_allowed_set
)

# =========================
# VISION API CONFIG
# =========================

VISION_API_KEY = os.getenv("OPENAI_API_KEY") or os.getenv("SILICON_KEY")
VISION_BASE_URL = os.getenv("VISION_BASE_URL") or "https://api.siliconflow.cn/v1"
VISION_MODEL = os.getenv("VISION_MODEL") or "Qwen/Qwen3-VL-32B-Thinking"
VISION_TIMEOUT = int(os.getenv("VISION_TIMEOUT", "120"))

# =========================
# IMAGE ENCODER
# =========================

def encode_image(image_path):
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode("utf-8")

# =========================
# VISION API CALL (urllib — avoids Windows httpx/SSL issues)
# =========================

def _call_vision_api(prompt, base64_image):
    """Send prompt + image to the vision API and return raw response text."""
    payload = json.dumps({
        "model": VISION_MODEL,
        "messages": [
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Analyze this tattoo image."},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}
                    }
                ]
            }
        ],
        "temperature": 0.1
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{VISION_BASE_URL}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {VISION_API_KEY}"
        },
        method="POST"
    )

    with urllib.request.urlopen(req, timeout=VISION_TIMEOUT) as resp:
        result = json.loads(resp.read())

    return result["choices"][0]["message"]["content"]

from analyzer.dictionary_loader import load_all_dictionaries

# Build allowed-set lookup once at module load
_ALLOWED_SET = _build_allowed_set(load_all_dictionaries())

# =========================
# ANALYZE IMAGE
# =========================

def analyze_image(image_path, mode="technical"):
    base64_image = encode_image(image_path)

    if mode == "strategy":
        prompt = STRATEGY_PROMPT
    else:
        prompt = build_analysis_prompt()

    raw_output = _call_vision_api(prompt, base64_image)

    parsed_json = extract_json(raw_output)

    if parsed_json is None:
        print("FAILED TO PARSE JSON")
        return None

    # Strategy analysis: skip technical validators, just return raw
    if mode == "strategy":
        return parsed_json

    parsed_json = autofix_json(parsed_json)

    errors = validate_json(parsed_json)
    if errors:
        print("VALIDATION ERRORS:")
        print(errors)

    normalized = normalize_json(parsed_json)

    validated = validate_fields(normalized, _ALLOWED_SET)
    return validated

# =========================
# TEST
# =========================

if __name__ == "__main__":
    IMAGE_PATH = "test.jpg"
    result = analyze_image(IMAGE_PATH)
    print(json.dumps(result, indent=2))
