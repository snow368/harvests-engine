import json

# =========================
# MASTER TAG MAPPINGS
# =========================

TAG_MAPPINGS = {

    # CAMERA
    "macro shot": "macro close-up",
    "extreme close-up": "extreme macro",
    "pov shot": "artist POV",
    "handheld filming": "handheld shot",
    "back view shot": "over-the-shoulder shot",
    "full back shot": "over-the-shoulder shot",

    # LIGHTING
    "industrial light": "industrial lighting",
    "cinematic moody lighting": "moody cinematic lighting",
    "cold industrial light": "cold industrial overhead lighting",
    "medium contrast": "medium contrast lighting",
    "soft shadow": "soft shadow lighting",
    "light shadow density": "light shadow lighting",
    "moderate shadow density": "moderate shadow lighting",
    "studio professional lighting": "studio professional",
    "medium shadow": "moderate shadow lighting",

    # MOTION
    "wipe motion": "wipe reveal",
    "needle movement": "needle vibration",
    "camera shake": "fast handheld motion",
    "static shot": "static movement",
    "no vibration": "none",

    # MATERIALS
    "wet ink shine": "wet ink reflection",
    "metal reflection": "metal machine reflection",
    "transparent cartridge": "transparent plastic texture",
    "glossy reflection lighting": "glossy reflection",

    # STYLE (cross-dictionary)
    "cinematic contrast lighting": "editorial cinematic",
    "cinematic": "editorial cinematic"
}

# =========================
# NORMALIZER
# =========================

def normalize_value(value):

    if isinstance(value, str):

        value = value.strip().lower()

        if value in TAG_MAPPINGS:
            return TAG_MAPPINGS[value]

        return value

    elif isinstance(value, list):

        normalized_list = []

        for item in value:

            item = normalize_value(item)

            if item not in normalized_list:
                normalized_list.append(item)

        return normalized_list

    elif isinstance(value, dict):

        return normalize_json(value)

    else:
        return value


def normalize_json(data):

    normalized = {}

    for key, value in data.items():

        normalized[key] = normalize_value(value)

    return normalized


# =========================
# TEST
# =========================

if __name__ == "__main__":

    sample = {
        "camera": {
            "shot_type": "macro shot"
        },
        "motion": {
            "motion_type": [
                "wipe motion",
                "needle movement"
            ]
        }
    }

    result = normalize_json(sample)

    print(json.dumps(result, indent=2))
