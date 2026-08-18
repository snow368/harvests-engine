#!/usr/bin/env python3
"""Preview/apply safe Maps artist deduplication in Neon.

Duplicates are merged only when normalized shop name AND physical address match.
This catches Google variants such as an address with/without ", United States"
without merging different locations that share a brand or Instagram account.

Usage:
  python scripts/dedupe_maps_artists.py AL
  python scripts/dedupe_maps_artists.py AL --apply
"""
import argparse
import asyncio
import os
import re
from collections import defaultdict
from pathlib import Path

import asyncpg


INVALID_IG = {
    "n/a", "p", "reel", "reels", "explore", "accounts", "stories",
    "popular", "direct", "share", "meta", "instagram", "wix", "squarespace",
}


def load_env():
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def norm_name(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def norm_address(value):
    text = re.sub(r",?\s*united states\s*$", "", str(value or "").strip().lower())
    text = re.sub(r"[^a-z0-9]", "", text)
    return "" if text in {"", "na", "none"} else text


def ig_handle(value):
    text = str(value or "").strip().lower()
    match = re.search(r"instagram\.com/([a-z0-9._-]+)", text)
    handle = match.group(1) if match else text.lstrip("@")
    return "" if handle in INVALID_IG or not re.fullmatch(r"[a-z0-9._-]+", handle) else handle


def present(value):
    return value is not None and str(value).strip().lower() not in {"", "n/a", "none"}


def row_score(row):
    return (
        20 * bool(ig_handle(row.get("ig_handle")))
        + 5 * present(row.get("email"))
        + 4 * present(row.get("website"))
        + 3 * present(row.get("phone"))
        + min(int(row.get("reviews") or 0), 1000) / 1000
        + (row.get("last_updated").timestamp() if row.get("last_updated") else 0) / 1e12
    )


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("state", type=str.upper)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    load_env()
    url = os.environ.get("NEON_DATABASE_URL")
    if not url:
        raise SystemExit("NEON_DATABASE_URL is missing")

    conn = await asyncpg.connect(url)
    rows = await conn.fetch(
        """SELECT * FROM artists
           WHERE source_type='maps_scrape' AND import_region=$1
           ORDER BY last_updated DESC NULLS LAST""",
        args.state,
    )
    groups = defaultdict(list)
    for record in rows:
        row = dict(record)
        key = (norm_name(row.get("shop_name")), norm_address(row.get("address")))
        if all(key):
            groups[key].append(row)
    duplicate_groups = [items for items in groups.values() if len(items) > 1]
    removable = sum(len(items) - 1 for items in duplicate_groups)
    invalid_ig_rows = [r for r in map(dict, rows) if present(r.get("ig_handle")) and not ig_handle(r.get("ig_handle"))]

    print(f"state={args.state} total={len(rows)} duplicate_groups={len(duplicate_groups)} removable={removable}")
    print(f"invalid_instagram_rows={len(invalid_ig_rows)} mode={'APPLY' if args.apply else 'DRY-RUN'}")
    for items in duplicate_groups[:20]:
        winner = max(items, key=row_score)
        print(f"  keep={winner['id']} rows={len(items)} shop={winner.get('shop_name')} address={winner.get('address')}")

    if not args.apply:
        print("No data changed. Re-run with --apply after reviewing this preview.")
        await conn.close()
        return

    merge_fields = ["ig_handle", "email", "website", "phone", "facebook", "tiktok", "rating", "reviews"]
    async with conn.transaction():
        for items in duplicate_groups:
            winner = max(items, key=row_score)
            merged = dict(winner)
            for field in merge_fields:
                candidates = [r.get(field) for r in sorted(items, key=row_score, reverse=True) if present(r.get(field))]
                if candidates:
                    merged[field] = candidates[0]
            handle = ig_handle(merged.get("ig_handle"))
            merged["ig_handle"] = f"https://www.instagram.com/{handle}" if handle else None
            await conn.execute(
                """UPDATE artists SET ig_handle=$2,email=$3,website=$4,phone=$5,
                   facebook=$6,tiktok=$7,rating=$8,reviews=$9,last_updated=NOW()
                   WHERE id=$1""",
                winner["id"], merged.get("ig_handle"), merged.get("email"), merged.get("website"),
                merged.get("phone"), merged.get("facebook"), merged.get("tiktok"),
                merged.get("rating"), merged.get("reviews"),
            )
            delete_ids = [r["id"] for r in items if r["id"] != winner["id"]]
            await conn.execute("DELETE FROM artists WHERE id = ANY($1::text[])", delete_ids)
        if invalid_ig_rows:
            await conn.execute(
                "UPDATE artists SET ig_handle=NULL WHERE id = ANY($1::text[])",
                [r["id"] for r in invalid_ig_rows],
            )
    print(f"Applied: removed={removable}, invalid_instagram_cleared={len(invalid_ig_rows)}")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
