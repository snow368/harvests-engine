#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bridge: Maps scraper CSV -> cloud-api D1 artists -> enqueue bot tasks.
Reads data/scrape_output/<STATE>_Raw.csv and:
  1) POST /api/artists/bulk-import  (upsert into D1 artists)
  2) GET  /api/automation/artists   (resolve ids)
  3) POST /api/automation/tasks/create-from-artists  (enqueue ig_browse tasks)
Idempotent: re-running re-imports (upsert) and re-enqueues only new artists.

Usage (run from engine dir, with the CSV at data/scrape_output/CA_Raw.csv):
  python scripts/_import_maps_to_d1.py CA
"""
import csv, json, re, subprocess, sys, os

# Try multiple endpoints/proxies so it works whether or not the host has a
# local socks5 proxy and whether workers.dev or pages.dev is reachable.
BASES = [
    "https://harvests-cloud-api.inkflowapp.workers.dev",
    "https://harvests.pages.dev",
]
PROXIES = ["", "socks5://127.0.0.1:10808"]
STATE_TAG = (sys.argv[1] if len(sys.argv) > 1 else "CA").upper()
CSV = f"data/scrape_output/{STATE_TAG}_Raw.csv"


def curl_json(method, path, data=None, token=None):
    payload = json.dumps(data, ensure_ascii=False) if data is not None else None
    # 大 JSON body 用临时文件传（--data-binary @file），绕开 Windows 命令行长度限制
    # （WinError 206 文件名或扩展名太长：145+ 行 CSV 的 JSON 拼进 -d 参数会超 32KB）
    tmpf = None
    if payload is not None and len(payload) > 8000:
        import tempfile
        tmpf = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        tmpf.write(payload)
        tmpf.close()
    last = None
    try:
        for base in BASES:
            for px in PROXIES:
                url = base + path
                cmd = ["curl.exe", "--ssl-no-revoke", "-s"]
                if px:
                    cmd += ["--proxy", px]
                cmd += ["-X", method, url, "-H", "Content-Type: application/json", "--max-time", "60"]
                if token:
                    cmd += ["-H", f"x-bot-key: {token}"]
                if payload is not None:
                    if tmpf:
                        cmd += ["--data-binary", "@" + tmpf.name]
                    else:
                        cmd += ["-d", payload]
                try:
                    r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
                except Exception as e:
                    last = {"error": str(e)[:200]}
                    continue
                out = r.stdout.strip()
                if not out:
                    last = {"raw": "", "stderr": (r.stderr or "")[:200]}
                    continue
                try:
                    j = json.loads(out)
                except Exception:
                    last = {"raw": out[:400], "stderr": (r.stderr or "")[:200]}
                    continue
                if isinstance(j, dict) and j.get("error") and not j.get("inserted") and not j.get("ok"):
                    last = j
                    continue
                return j
        return last or {"error": "all endpoints failed"}
    finally:
        if tmpf:
            import os
            try: os.unlink(tmpf.name)
            except Exception: pass


def ig_handle(url):
    if not url or url == "N/A":
        return ""
    m = re.search(r"instagram\.com/([a-zA-Z0-9._-]+)", url)
    return m.group(1).lower() if m else ""


def clean(v):
    v = (v or "").strip()
    return "" if v in ("N/A", "nan", "None") else v


def main():
    if not os.path.exists(CSV):
        print(f"CSV not found: {CSV}")
        return
    rows = []
    with open(CSV, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            name = clean(r.get("Shop Name"))
            if not name:
                continue
            ig = ig_handle(r.get("Instagram", ""))
            rows.append({
                "shop_name": name,
                "ig_handle": ig,
                "city": clean(r.get("City")),
                "state": clean(r.get("State")),
                "country": clean(r.get("Country")) or "USA",
                "phone": clean(r.get("Phone")),
                "website": clean(r.get("Website")),
                "email": clean(r.get("Email")),
                "rating": (float(r["Rating"]) if clean(r.get("Rating")) else None),
                "reviews": (int(r["Reviews"]) if str(clean(r.get("Reviews"))).isdigit() else 0),
                "address": clean(r.get("Address")),
            })
    print(f"read {len(rows)} shops from {CSV}")

    res = curl_json("POST", "/api/artists/bulk-import",
                    {"rows": rows, "importRegion": STATE_TAG, "defaultCountry": "USA"})
    print("bulk-import:", res)

    arts = curl_json("GET", "/api/automation/artists?limit=5000&page=1")
    items = arts.get("items", []) if isinstance(arts, dict) else []
    imported_keys = {(clean(r["ig_handle"]) or clean(r["shop_name"])).lower() for r in rows}
    ids = []
    for a in items:
        key = (a.get("ig_handle") or a.get("shop_name") or "").lower()
        if key in imported_keys:
            ids.append(a.get("id"))
    print(f"matched {len(ids)} artist ids in D1")

    if ids:
        enq = curl_json("POST", "/api/automation/tasks/create-from-artists",
                        {"artistIds": ids, "taskType": "ig_browse"},
                        token="vps-bot-secret-2024")
        print("create-from-artists:", enq)
    else:
        print("no ids to enqueue")


if __name__ == "__main__":
    main()
