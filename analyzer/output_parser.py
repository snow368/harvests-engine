import json
import re


def extract_json(text):

    try:

        return json.loads(text)

    except:

        pass

    json_match = re.search(r"\{.*\}", text, re.DOTALL)

    if json_match:

        json_text = json_match.group(0)

        try:

            return json.loads(json_text)

        except Exception as e:

            print("JSON PARSE ERROR:")
            print(e)

    return None


def save_output(filepath, data):

    with open(filepath, "w", encoding="utf-8") as f:

        json.dump(
            data,
            f,
            indent=2,
            ensure_ascii=False
        )


if __name__ == "__main__":

    sample = """
    {
      "content_type": "tattoo_process"
    }
    """

    result = extract_json(sample)

    print(result)
