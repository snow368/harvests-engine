import json

# =========================
# REQUIRED SCHEMA
# =========================

REQUIRED_FIELDS = {

    "content_id": str,
    "platform": str,
    "content_type": str,

    "camera": dict,
    "lighting": dict,
    "composition": dict,
    "materials": dict,
    "motion": dict,

    "tattoo_authenticity": dict,
    "social_media": dict,

    "style_keywords": list,
    "generation_ready": dict
}

# =========================
# VALIDATOR
# =========================

def validate_json(data):

    errors = []

    for field, field_type in REQUIRED_FIELDS.items():

        if field not in data:

            errors.append(f"Missing field: {field}")

        else:

            if not isinstance(data[field], field_type):

                errors.append(
                    f"Invalid type for {field}. "
                    f"Expected {field_type.__name__}"
                )

    return errors


# =========================
# AUTO FIX
# =========================

def autofix_json(data):

    for field, field_type in REQUIRED_FIELDS.items():

        if field not in data:

            if field_type == str:
                data[field] = "unknown"

            elif field_type == dict:
                data[field] = {}

            elif field_type == list:
                data[field] = []

    return data


# =========================
# LOAD JSON
# =========================

def load_json(filepath):

    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


# =========================
# SAVE JSON
# =========================

def save_json(filepath, data):

    with open(filepath, "w", encoding="utf-8") as f:

        json.dump(
            data,
            f,
            indent=2,
            ensure_ascii=False
        )


# =========================
# TEST
# =========================

if __name__ == "__main__":

    sample = {
        "content_id": "FK_001",
        "platform": "instagram"
    }

    sample = autofix_json(sample)

    errors = validate_json(sample)

    print("VALIDATION ERRORS:")
    print(errors)

    print("\nFIXED JSON:")
    print(json.dumps(sample, indent=2))
