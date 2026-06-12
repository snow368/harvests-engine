import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(__file__))

DICTIONARY_DIR = os.path.join(BASE_DIR, "dictionaries")
TAXONOMY_DIR = os.path.join(BASE_DIR, "taxonomy")


def load_json_file(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def load_all_dictionaries():
    dictionaries = {}
    for file in os.listdir(DICTIONARY_DIR):
        if file.endswith(".json"):
            path = os.path.join(DICTIONARY_DIR, file)
            key = file.replace(".json", "")
            dictionaries[key] = load_json_file(path)
    return dictionaries


def load_all_taxonomies():
    taxonomies = {}
    if not os.path.exists(TAXONOMY_DIR):
        return taxonomies
    for file in os.listdir(TAXONOMY_DIR):
        if file.endswith(".json"):
            path = os.path.join(TAXONOMY_DIR, file)
            key = file.replace(".json", "")
            taxonomies[key] = load_json_file(path)
    return taxonomies


if __name__ == "__main__":
    dicts = load_all_dictionaries()
    taxs = load_all_taxonomies()
    print("Dictionaries:", list(dicts.keys()))
    print("Taxonomies:", list(taxs.keys()))
