#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build GeoNames US state->cities cache from official dump:
https://download.geonames.org/export/dump/US.zip
"""

import io
import json
import os
import time
import zipfile
import urllib.request
from collections import defaultdict

URL = "https://download.geonames.org/export/dump/US.zip"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "data")
OUT_FILE = os.path.join(OUT_DIR, "geonames_us_places_by_state.json")


def norm_city(name: str) -> str:
    name = (name or "").strip()
    if not name:
        return ""
    return " ".join(name.split())


def download_with_retry(url: str, retries: int = 3, timeout: int = 180) -> bytes:
    last_err = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last_err = e
            if i < retries - 1:
                time.sleep(2 + i * 2)
    raise last_err


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    raw = download_with_retry(URL)
    zf = zipfile.ZipFile(io.BytesIO(raw))
    inner = "US.txt" if "US.txt" in zf.namelist() else zf.namelist()[0]
    rows = zf.read(inner).decode("utf-8", errors="ignore").splitlines()

    # Columns: geoname dump format
    # 6 feature_class, 7 feature_code, 8 country_code, 10 admin1_code
    by_state = defaultdict(dict)
    for line in rows:
        p = line.split("\t")
        if len(p) < 15:
            continue
        feature_class = p[6]
        feature_code = p[7]
        country_code = p[8]
        admin1 = p[10]
        city = norm_city(p[1])
        if country_code != "US":
            continue
        if feature_class != "P":
            continue
        if not feature_code.startswith("PPL"):
            continue
        if not admin1 or not city:
            continue
        try:
            pop = int(p[14] or 0)
        except Exception:
            pop = 0
        # Keep max population per normalized city label
        prev = by_state[admin1].get(city, 0)
        if pop > prev:
            by_state[admin1][city] = pop

    out = {
        "source": URL,
        "generatedAt": int(time.time()),
        "states": {
            k: [{"name": name, "population": pop} for name, pop in sorted(v.items(), key=lambda x: x[0])]
            for k, v in sorted(by_state.items())
        },
    }
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    total_states = len(out["states"])
    total_cities = sum(len(v) for v in out["states"].values())
    print(
        json.dumps(
            {
                "ok": True,
                "output": OUT_FILE,
                "states": total_states,
                "cities": total_cities,
                "wa": len(out["states"].get("WA", [])),
            }
        )
    )


if __name__ == "__main__":
    main()
