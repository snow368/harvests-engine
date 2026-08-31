#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Google Maps 纹身店抓取器 - 集成 Neon DB + CSV 双输出
移植自 Maps_Scanner_Universal.py 的 Google fallback / 区域过滤 / URL 验证
"""

import asyncio
import random
import urllib.parse
import re
import os
import json
import csv
import hashlib
import argparse
import sys
from datetime import datetime
from pathlib import Path
import asyncpg
from playwright.async_api import async_playwright

# ========== 自动加载 .env（本机开发用，服务器走系统环境变量） ==========
def load_dotenv():
    env_path = Path(__file__).resolve().parent.parent / '.env'
    if not env_path.exists():
        return
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            key, val = key.strip(), val.strip()
            if key and val and key not in os.environ:
                os.environ[key] = val

load_dotenv()

# ========== 参数解析 ==========
parser = argparse.ArgumentParser()
parser.add_argument('--state', required=True)
parser.add_argument('--country', default='USA')
parser.add_argument('--cities', default='')
parser.add_argument('--cities-file', default='')
parser.add_argument('--headless', default='true')
parser.add_argument('--keyword', default='Tattoo Shops')
parser.add_argument('--task-id', default='')
parser.add_argument('--cdp-url', default='http://127.0.0.1:9222')
parser.add_argument('--output-dir', default='./data/scrape_output')
parser.add_argument('--start-from-city', default='')
# --- Cloud coverage reporting (Maps Scrape page) ---
# Pass --job-id to update a pre-created job, or let the script self-register
# by (country, state). Needs CLOUD_API_BASE (e.g. https://harvests.pages.dev/api)
# and a bot token. If CLOUD_API_BASE is empty the script runs standalone (no API calls).
parser.add_argument('--job-id', default='')
parser.add_argument('--cloud-base', default=os.environ.get('CLOUD_API_BASE', 'https://harvests.pages.dev/api'))
parser.add_argument('--cloud-token', default=os.environ.get('SCRAPE_JOB_TOKEN', 'vps-bot-secret-2024'))
parser.add_argument('--register-only', action='store_true',
                    help='Count existing CSV rows and mark the (country,state) job completed without scraping.')
args = parser.parse_args()

STATE = args.state
COUNTRY = args.country
HEADLESS = args.headless.lower() == 'true'
KEYWORD = args.keyword
TASK_ID = args.task_id
CDP_URL = (args.cdp_url or '').strip()
OUTPUT_DIR = args.output_dir
STATE_TAG = re.sub(r'[^a-zA-Z0-9]', '', STATE).upper()

# ========== Cloud coverage reporting ==========
JOB_ID = args.job_id.strip()
CLOUD_BASE = (args.cloud_base or '').strip()
CLOUD_TOKEN = (args.cloud_token or '').strip() or 'vps-bot-secret-2024'
REGISTER_ONLY = args.register_only

# ========== Gentle pacing（避免限流 / 验证码）==========
# 全部可用环境变量覆盖，单位毫秒 / 个数
CITY_DELAY_MIN = int(os.environ.get('SCRAPE_CITY_DELAY_MIN_MS', '20000'))   # 城市间最小拟人延迟
CITY_DELAY_MAX = int(os.environ.get('SCRAPE_CITY_DELAY_MAX_MS', '40000'))   # 城市间最大拟人延迟
COOLDOWN_EVERY = int(os.environ.get('SCRAPE_COOLDOWN_EVERY', '10'))         # 每 N 城长冷却一次
COOLDOWN_MS    = int(os.environ.get('SCRAPE_COOLDOWN_MS', '240000'))        # 长冷却时长（默认 4 分钟）
CAPTCHA_BACKOFF_MS = int(os.environ.get('SCRAPE_CAPTCHA_BACKOFF_MS', '600000'))  # 命中验证码退避（默认 10 分钟）
WEBSITE_PROBE_ENABLED = os.environ.get('SCRAPE_WEBSITE_PROBE_ENABLED', 'false').lower() in ('1', 'true', 'yes')
SOCIAL_SEARCH_DELAY_MIN = int(os.environ.get('SCRAPE_SOCIAL_DELAY_MIN_MS', '20000'))
SOCIAL_SEARCH_DELAY_MAX = int(os.environ.get('SCRAPE_SOCIAL_DELAY_MAX_MS', '40000'))
SOCIAL_SEARCH_COOLDOWN_EVERY = int(os.environ.get('SCRAPE_SOCIAL_COOLDOWN_EVERY', '5'))
SOCIAL_SEARCH_COOLDOWN_MS = int(os.environ.get('SCRAPE_SOCIAL_COOLDOWN_MS', '180000'))

def city_delay_seconds() -> float:
    return random.uniform(CITY_DELAY_MIN, CITY_DELAY_MAX) / 1000.0

def cooldown_seconds() -> float:
    return COOLDOWN_MS / 1000.0

def captcha_backoff_seconds() -> float:
    return CAPTCHA_BACKOFF_MS / 1000.0

_CAPTCHA_SIGNALS = [
    'unusual traffic', 'prove you are human', 'our systems have detected',
    'automated queries', 'browser check', 'verify you are human',
    'please complete the security check', "i'm not a robot", 'not a robot',
    'temporarily blocked', 'too many requests',
]

async def detect_captcha(page) -> bool:
    """检测 Google 限流 / 验证码页。返回 True 表示需要退避。"""
    try:
        if '/sorry/' in page.url.lower():
            return True
        txt = (await page.locator('body').inner_text(timeout=5000)).lower()
        return any(s in txt for s in _CAPTCHA_SIGNALS)
    except Exception:
        return False

import urllib.request as _urllib

def _cloud_call(path: str, payload: dict):
    """POST JSON to the cloud API. Returns parsed dict or None. No-op if CLOUD_BASE unset."""
    if not CLOUD_BASE:
        return None
    url = CLOUD_BASE.rstrip('/') + path
    data = json.dumps(payload).encode('utf-8')
    req = _urllib.Request(url, data=data, method='POST', headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CLOUD_TOKEN,
        # Cloudflare/Pages 会拦 Python-urllib 默认 UA（返回 403），加浏览器 UA 放行，
        # 否则 scraper 自身 cloud_status 上报全部 403，任务抓完卡在 running。
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    })
    try:
        with _urllib.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        print(json.dumps({"type": "log", "message": f"cloud call failed {path}: {str(e)[:150]}"}))
        return None

def cloud_register():
    """Upsert a job by (country, state); returns the job id (or None)."""
    global JOB_ID
    if JOB_ID:
        return JOB_ID
    res = _cloud_call('/api/maps-scrape/jobs', {
        'country': (COUNTRY or 'USA').upper(),
        'state': STATE.upper(),
        'cities': CITIES,
    })
    if res and res.get('ok') and res.get('job'):
        JOB_ID = res['job'].get('id')
        return JOB_ID
    return None

def cloud_status(status, cities_done=None, cities_total=None, artists_found=None, error=None):
    """Report progress for the current job id (no-op if no job id)."""
    if not JOB_ID:
        return
    payload = {'status': status}
    if cities_done is not None: payload['cities_done'] = cities_done
    if cities_total is not None: payload['cities_total'] = cities_total
    if artists_found is not None: payload['artists_found'] = artists_found
    if error is not None: payload['error'] = error
    _cloud_call(f'/api/maps-scrape/jobs/{JOB_ID}/status', payload)
    # 同时打印 progress JSON 供 scheduler 兜底更新进度条（scraper 自身 cloud_status 偶发 403，这里双写）
    if cities_done is not None and cities_total is not None:
        print(json.dumps({"type": "progress", "phase": "end", "current": int(cities_done), "total": int(cities_total), "shops_found": int(artists_found or 0)}))

def parse_cities(raw: str):
    s = (raw or "").strip()
    if not s:
        return []
    try:
        data = json.loads(s)
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
    except Exception:
        pass
    s = s.strip("[]")
    parts = [p.strip().strip('"').strip("'") for p in s.split(",")]
    return [p for p in parts if p]

# Load cities from multiple sources
CITIES = parse_cities(args.cities)
if args.cities_file and os.path.exists(args.cities_file):
    with open(args.cities_file, 'r', encoding='utf-8') as f:
        file_cities = [x.strip() for x in f if x.strip()]
    if not CITIES:
        CITIES = file_cities
    else:
        CITIES.extend([c for c in file_cities if c not in CITIES])

if not CITIES:
    print(json.dumps({"type": "error", "message": "No cities provided. Use --cities or --cities-file"}))
    sys.exit(1)

DATABASE_URL = os.environ.get('NEON_DATABASE_URL')
if not DATABASE_URL:
    print(json.dumps({"type": "error", "message": "NEON_DATABASE_URL not set"}))
    sys.exit(1)

UID = '6L5jF9zmRvcnyS9SRb559SnasxF3'
INVALID_IG_SEGMENTS = {
    "p", "reel", "reels", "explore", "accounts", "stories",
    "tv", "about", "developer", "directory", "legal", "privacy", "api",
    "popular", "direct", "share", "meta", "instagram", "wix", "squarespace"
}
INVALID_FB_SEGMENTS = {"sharer", "plugins", "dialog", "help", "login", "profile.php", "profile"}

# ========== 输出路径 ==========
os.makedirs(OUTPUT_DIR, exist_ok=True)
MASTER_CSV = os.path.join(OUTPUT_DIR, f"{STATE_TAG}_Raw.csv")
VIEW_CSV = os.path.join(OUTPUT_DIR, f"{STATE_TAG}_Live_Scrape_View.csv")
PROGRESS_LOG = os.path.join(OUTPUT_DIR, f"{STATE_TAG}_scanned_cities.log")
CSV_FIELDS = [
    "Shop Name", "Reviews", "Address", "Phone",
    "Instagram", "Facebook", "TikTok", "Website", "City", "State", "Country",
    "Email", "Rating", "Scraped At"
]

# ========== 工具函数 ==========
def normalize_string(s):
    if not s: return ""
    return re.sub(r'[^a-zA-Z0-9]', '', str(s)).lower()

def canonical_address(value: str) -> str:
    """Stable physical-address key across Google locale/rendering variants."""
    value = str(value or "").strip().lower()
    value = re.sub(r",?\s*united states\s*$", "", value)
    value = re.sub(r"[^a-z0-9]", "", value)
    return "" if value in {"", "na", "none"} else value


def canonical_phone(value: str) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return "" if digits in {"", "0"} else digits[-10:]


def instagram_handle(value: str) -> str:
    value = str(value or "").strip()
    if not value or value.upper() == "N/A":
        return ""
    m = re.search(r"instagram\.com/([a-zA-Z0-9._-]+)", value, re.I)
    handle = (m.group(1) if m else value.lstrip("@")).strip().lower()
    if handle in INVALID_IG_SEGMENTS or not re.fullmatch(r"[a-z0-9._-]+", handle):
        return ""
    return handle


def canonical_instagram_url(value: str):
    handle = instagram_handle(value)
    return f"https://www.instagram.com/{handle}" if handle else None


def google_place_key(url: str) -> str:
    """Extract Google's stable Maps feature id from a place URL."""
    raw = urllib.parse.unquote(str(url or ""))
    m = re.search(r"!1s([^!]+)", raw)
    if m:
        return re.sub(r"[^a-zA-Z0-9:_-]", "", m.group(1)).lower()
    m = re.search(r"(ChIJ[a-zA-Z0-9_-]+)", raw)
    return m.group(1).lower() if m else ""


def shop_identity_keys(shop: dict):
    keys = set()
    place_id = str(shop.get("maps_place_id") or "").strip().lower()
    address = canonical_address(shop.get("address", ""))
    phone = canonical_phone(shop.get("phone", ""))
    handle = instagram_handle(shop.get("instagram", ""))
    name = normalize_string(shop.get("name", ""))
    city = normalize_string(shop.get("city", ""))
    if place_id:
        keys.add(f"place:{place_id}")
    if address:
        keys.add(f"address:{address}")
    if phone and name:
        keys.add(f"phone:{phone}:{name}")
    if handle and name:
        keys.add(f"instagram:{handle}:{name}")
    if name and city:
        keys.add(f"city:{name}:{city}")
    return keys


def shop_dedupe_key(shop: dict) -> str:
    keys = shop_identity_keys(shop)
    for prefix in ("place:", "address:", "phone:", "instagram:", "city:"):
        hit = next((key for key in keys if key.startswith(prefix)), None)
        if hit:
            return hit
    return ""


def generate_shop_id(name, address, phone, maps_place_id=""):
    shop = {"name": name, "address": address, "phone": phone, "maps_place_id": maps_place_id}
    stable = shop_dedupe_key(shop) or f"name:{normalize_string(name)}"
    return "maps_" + hashlib.sha1(stable.encode("utf-8")).hexdigest()[:32]

def clean_url(url):
    if not url:
        return "N/A"
    if "/url?q=" in url:
        try:
            return urllib.parse.unquote(url.split("url?q=")[1].split("&")[0]).split("?")[0].rstrip('/')
        except:
            pass
    return url.split("?")[0].rstrip('/')

def clean_text_field(value):
    s = str(value or "").replace("\n", " ").strip()
    s = re.sub(r'^[^\w+]+', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s if s else "N/A"

def parse_review_count_from_text(text: str) -> int:
    if not text:
        return 0
    m = re.search(r'(\d{1,3}(?:,\d{3})*)\s*reviews?', text, re.I)
    if m:
        try:
            return int(m.group(1).replace(',', ''))
        except:
            return 0
    nums = re.findall(r'[\d,]+', text)
    return int(nums[0].replace(',', '')) if nums else 0

def normalize_social_url(url: str) -> str:
    """Validate and normalize Instagram/Facebook/TikTok URLs"""
    if not url:
        return "N/A"
    u = str(url).strip().replace("&amp;", "&")
    # Google no longer consistently uses /url?q=. Current result links often
    # use /url?...&url=<target>, so parse both forms before social detection.
    try:
        parsed = urllib.parse.urlparse(u)
        host = parsed.netloc.lower()
        if "google." in host and parsed.path.rstrip("/") == "/url":
            params = urllib.parse.parse_qs(parsed.query)
            target = (params.get("url") or params.get("q") or [""])[0]
            if target:
                u = urllib.parse.unquote(target)
    except Exception:
        pass
    if "instagram.com/" in u:
        m = re.search(r"https?://(?:www\.)?instagram\.com/[a-zA-Z0-9._-]+", u)
        return m.group(0).rstrip("/") if m else "N/A"
    if "facebook.com/" in u or "fb.com/" in u:
        m = re.search(r"https?://(?:www\.)?(?:facebook\.com|fb\.com)/[a-zA-Z0-9._-]+", u)
        return m.group(0).rstrip("/") if m else "N/A"
    if "tiktok.com/" in u:
        m = re.search(r"https?://(?:www\.)?tiktok\.com/@?[a-zA-Z0-9._-]+", u)
        return m.group(0).rstrip("/") if m else "N/A"
    return "N/A"

def is_valid_instagram_url(url: str) -> bool:
    u = str(url or "").strip().lower()
    if not u or "instagram.com/" not in u:
        return False
    bad_tokens = ["/meta", "/accounts", "/explore", "/developer", "/about", "/legal", "/reel", "/p/"]
    if any(t in u for t in bad_tokens):
        return False
    m = re.search(r"instagram\.com/([a-zA-Z0-9._-]+)", u)
    if not m:
        return False
    handle = m.group(1)
    if handle in INVALID_IG_SEGMENTS:
        return False
    return True

def is_valid_facebook_url(url: str) -> bool:
    u = str(url or "").strip().lower()
    if not u or ("facebook.com/" not in u and "fb.com/" not in u):
        return False
    bad_tokens = ["/login", "/profile.php", "/share", "/sharer", "/plugins", "/help", "/privacy", "/policies", "/p/", "/pages/"]
    if any(t in u for t in bad_tokens):
        return False
    m = re.search(r"(?:facebook\.com|fb\.com)/([^/?#]+)", u)
    if m:
        slug = m.group(1).strip()
        if slug.isdigit():
            return False
    return True

def is_valid_tiktok_url(url: str) -> bool:
    u = str(url or "").strip().lower()
    if not u or "tiktok.com/" not in u:
        return False
    bad_tokens = ["/trending", "/discover", "/share", "/music", "/tag", "/video/"]
    if any(t in u for t in bad_tokens):
        return False
    m = re.search(r"tiktok\.com/@?([a-zA-Z0-9._-]+)", u)
    if not m:
        return False
    handle = m.group(1)
    if handle in {"tiktok", "explore", "live", "about"}:
        return False
    return True

def is_same_region(address: str, state: str, country: str) -> bool:
    """Filter out out-of-state results"""
    a = str(address or "").lower()
    st = str(state or "").lower()
    ct = str(country or "").lower()
    if not a:
        return True  # no address = can't judge, keep
    state_tokens = {
        "washington": [" wa ", ", wa", " washington", "washington,"],
        "utah": [" ut ", ", ut", " utah", "utah,"],
        "california": [" ca ", ", ca", " california", "california,"],
        "texas": [" tx ", ", tx", " texas", "texas,"],
        "new york": [" ny ", ", ny", " new york", "new york,"],
        "oregon": [" or ", ", or", " oregon", "oregon,"],
        "idaho": [" id ", ", id", " idaho", "idaho,"],
    }
    toks = state_tokens.get(st, [f" {st}", f",{st}"])
    return any(t in f" {a} " for t in toks)

def normalize_city_input(city: str) -> str:
    x = str(city or "").strip()
    x = re.sub(r"\s+", " ", x)
    x = re.sub(r"\bCDP\b", "", x, flags=re.I).strip()
    x = re.sub(r",\s*[A-Z]{2}\s*$", "", x).strip()
    return x

# ========== CSV 输出 ==========
def append_to_csv(row: dict):
    """Write row to master CSV and overwrite single-row view CSV"""
    file_exists = os.path.isfile(MASTER_CSV)
    with open(MASTER_CSV, "a", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)
    # View CSV: single row snapshot (for live monitoring)
    with open(VIEW_CSV, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerow(row)

def mark_city_scanned(city_norm: str):
    with open(PROGRESS_LOG, "a", encoding="utf-8") as f:
        f.write(city_norm + "\n")

def load_finished():
    """
    断点续核心逻辑：严格区分「城市级完成」与「店铺级去重」。

    - done_cities（城市级是否跳过）= 仅取进度日志 PROGRESS_LOG。
      只有整城 scrape_city 成功返回后才会 mark_city_scanned 写入日志，
      因此「跑到一半崩了」的城市不会被判为已完成 → 下次续跑会重新进入任务队列，
      再由 done_shops 的店铺级去重跳过已入库店铺，从而「从断点继续」而非整城重抓或整城丢数据。
    - done_shops（店铺级去重）= CSV 已落盘的店铺键（main 中还会并上 DB 已存店铺）。
      用于 scrape_city 内跳过已保存店铺，保证续跑不产生重复行。
    重要：CSV 里某城只有半截店铺 ≠ 该城已完成，所以这里不再把 CSV 中的城市计入 done_cities。
    """
    done_cities = set()
    done_shops = set()
    if os.path.exists(MASTER_CSV):
        try:
            with open(MASTER_CSV, 'r', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    city = normalize_string(row.get('City', ''))
                    shop = normalize_string(row.get('Shop Name', ''))
                    if shop and city:
                        done_shops.add(f"city:{shop}:{city}")
                    address = canonical_address(row.get('Address', ''))
                    if address:
                        done_shops.add(f"address:{address}")
                    handle = instagram_handle(row.get('Instagram', ''))
                    if handle and shop:
                        done_shops.add(f"instagram:{handle}:{shop}")
        except:
            pass
    if os.path.exists(PROGRESS_LOG):
        with open(PROGRESS_LOG, 'r', encoding='utf-8') as f:
            for line in f:
                x = line.strip()
                if x:
                    done_cities.add(x)
    return done_cities, done_shops

# ========== 数据库 ==========
async def init_db():
    """连接 Neon DB，失败返回 None（CSV 模式继续工作）"""
    if not DATABASE_URL:
        print(json.dumps({"type": "log", "message": "NEON_DATABASE_URL not set, running in CSV-only mode"}))
        return None
    try:
        conn = await asyncio.wait_for(asyncpg.connect(DATABASE_URL), timeout=15)
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS artists (
                id TEXT PRIMARY KEY,
                uid TEXT,
                username TEXT,
                full_name TEXT,
                shop_name TEXT,
                stage TEXT,
                rating INTEGER,
                reviews INTEGER,
                address TEXT,
                phone TEXT,
                website TEXT,
                ig_handle TEXT,
                facebook TEXT,
                email TEXT,
                city TEXT,
                source_type TEXT,
                entity_type TEXT,
                import_region TEXT,
                last_updated TIMESTAMP
            )
        ''')
        for col in ['rating', 'facebook', 'email', 'tiktok']:
            await conn.execute(f"ALTER TABLE artists ADD COLUMN IF NOT EXISTS {col} TEXT")
        await conn.execute("ALTER TABLE artists ADD COLUMN IF NOT EXISTS dedupe_key TEXT")
        await conn.execute("ALTER TABLE artists ADD COLUMN IF NOT EXISTS maps_place_id TEXT")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_artists_maps_dedupe ON artists (import_region, dedupe_key)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_artists_maps_place ON artists (import_region, maps_place_id)")
        print(json.dumps({"type": "log", "message": "Neon DB connected"}))
        return conn
    except Exception as e:
        print(json.dumps({"type": "error", "message": f"DB connect failed (CSV mode only): {str(e)[:200]}"}))
        return None

async def save_shop(conn, shop):
    """保存到 Neon。连接失效时自动重连一次并返回新连接（无则返回原 conn）。"""
    dedupe_key = shop_dedupe_key(shop)
    maps_place_id = str(shop.get('maps_place_id') or '').strip().lower() or None
    address_key = canonical_address(shop.get('address', ''))
    ig_url = canonical_instagram_url(shop.get('instagram', ''))
    shop_id = generate_shop_id(shop['name'], shop.get('address', ''), shop.get('phone', ''), maps_place_id or '')
    rating_int = int(round(shop.get('rating', 0)))
    try:
        # Match legacy rows before inserting. Older IDs changed when Google added
        # ", United States" or the same shop appeared in a neighbouring-city search.
        existing_id = await conn.fetchval('''
            SELECT id FROM artists
            WHERE source_type = 'maps_scrape' AND import_region = $1
              AND (
                ($2::text IS NOT NULL AND maps_place_id = $2)
                OR ($3::text <> '' AND dedupe_key = $3)
                OR ($4::text <> '' AND regexp_replace(
                    regexp_replace(lower(trim(COALESCE(address, ''))), ',?\\s*united states\\s*$', '', 'i'),
                    '[^a-z0-9]', '', 'g') = $4)
              )
            ORDER BY last_updated DESC NULLS LAST
            LIMIT 1
        ''', STATE, maps_place_id, dedupe_key, address_key)
        if existing_id:
            shop_id = existing_id
        await conn.execute('''
        INSERT INTO artists (id, uid, username, full_name, shop_name, stage,
                             rating, reviews, address, phone, website,
                             ig_handle, facebook, tiktok, email, city,
                             source_type, entity_type, import_region, dedupe_key,
                             maps_place_id, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW())
        ON CONFLICT (id) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            shop_name = EXCLUDED.shop_name,
            address = EXCLUDED.address,
            phone = EXCLUDED.phone,
            website = EXCLUDED.website,
            ig_handle = COALESCE(EXCLUDED.ig_handle, artists.ig_handle),
            facebook = COALESCE(EXCLUDED.facebook, artists.facebook),
            tiktok = COALESCE(EXCLUDED.tiktok, artists.tiktok),
            email = COALESCE(EXCLUDED.email, artists.email),
            city = EXCLUDED.city,
            dedupe_key = COALESCE(EXCLUDED.dedupe_key, artists.dedupe_key),
            maps_place_id = COALESCE(EXCLUDED.maps_place_id, artists.maps_place_id),
            rating = EXCLUDED.rating,
            reviews = EXCLUDED.reviews,
            last_updated = NOW()
        ''', shop_id, UID,
            shop['name'].replace(' ', '_').lower(), shop['name'], shop['name'], 'outreach',
            rating_int, shop.get('reviewCount', 0), shop.get('address'), shop.get('phone'), shop.get('website'),
            ig_url, None if shop.get('facebook') == 'N/A' else shop.get('facebook'),
            None if shop.get('tiktok') == 'N/A' else shop.get('tiktok'),
            None if shop.get('email') == 'N/A' else shop.get('email'), shop['city'],
            'maps_scrape', 'tattoo_shop', STATE, dedupe_key or None, maps_place_id)
        return conn
    except (asyncpg.exceptions.InterfaceError, asyncpg.PostgresError, OSError) as e:
        # 连接可能已被服务端关闭（长时间运行），重建连接重试一次
        msg = str(e or '').lower()
        if any(k in msg for k in ['closed', 'timeout', 'reset', 'connection']):
            print(json.dumps({"type": "log", "message": f"DB conn lost, reconnecting: {shop['name']}"}))
            try:
                new_conn = await asyncio.wait_for(asyncpg.connect(DATABASE_URL), timeout=15)
                await new_conn.execute('''
                INSERT INTO artists (id, uid, username, full_name, shop_name, stage,
                                     rating, reviews, address, phone, website,
                                     ig_handle, facebook, tiktok, email, city,
                                     source_type, entity_type, import_region, dedupe_key,
                                     maps_place_id, last_updated)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    full_name = EXCLUDED.full_name,
                    shop_name = EXCLUDED.shop_name,
                    address = EXCLUDED.address,
                    phone = EXCLUDED.phone,
                    website = EXCLUDED.website,
                    ig_handle = COALESCE(EXCLUDED.ig_handle, artists.ig_handle),
                    facebook = COALESCE(EXCLUDED.facebook, artists.facebook),
                    tiktok = COALESCE(EXCLUDED.tiktok, artists.tiktok),
                    email = COALESCE(EXCLUDED.email, artists.email),
                    city = EXCLUDED.city,
                    dedupe_key = COALESCE(EXCLUDED.dedupe_key, artists.dedupe_key),
                    maps_place_id = COALESCE(EXCLUDED.maps_place_id, artists.maps_place_id),
                    rating = EXCLUDED.rating,
                    reviews = EXCLUDED.reviews,
                    last_updated = NOW()
                ''', shop_id, UID,
                    shop['name'].replace(' ', '_').lower(), shop['name'], shop['name'], 'outreach',
                    rating_int, shop.get('reviewCount', 0), shop.get('address'), shop.get('phone'), shop.get('website'),
                    ig_url, None if shop.get('facebook') == 'N/A' else shop.get('facebook'),
                    None if shop.get('tiktok') == 'N/A' else shop.get('tiktok'),
                    None if shop.get('email') == 'N/A' else shop.get('email'), shop['city'],
                    'maps_scrape', 'tattoo_shop', STATE, dedupe_key or None, maps_place_id)
                return new_conn
            except Exception as e2:
                print(json.dumps({"type": "error", "message": f"DB reconnect failed: {shop['name']} | {str(e2)[:150]}"}))
                raise
        raise

# ==================== 社交链接提取 ====================
async def extract_socials(page):
    res = {"ig": "N/A", "fb": "N/A", "tk": "N/A", "emails": set()}
    try:
        html = await page.content()
        ig_m = re.search(r"https?://(?:www\.)?instagram\.com/([a-zA-Z0-9._-]+)", html)
        if ig_m:
            ig_url = ig_m.group(0).rstrip("/")
            if not any(x in ig_url.lower() for x in ["/reels", "/p/", "/explore", "/accounts"]):
                res["ig"] = ig_url
        fb_m = re.search(r"https?://(?:www\.)?(?:facebook\.com|fb\.com)/([a-zA-Z0-9._-]+)", html)
        if fb_m:
            fb_url = fb_m.group(0).rstrip("/")
            if not any(x in fb_url.lower() for x in ["/tr", "/sharer", "/plugins"]):
                res["fb"] = fb_url
        tk_m = re.search(r"https?://(?:www\.)?tiktok\.com/@?([a-zA-Z0-9._-]+)", html)
        if tk_m:
            tk_url = tk_m.group(0).rstrip("/")
            if is_valid_tiktok_url(tk_url):
                res["tk"] = tk_url
        emails = re.findall(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", html)
        for e in emails:
            if not any(x in e.lower() for x in [".png", ".jpg", ".jpeg", ".gif", "sentry.io", "wixpress"]):
                res["emails"].add(e)

        anchors = await page.locator("a[href]").all()
        for a in anchors:
            href = await a.get_attribute("href")
            if not href:
                continue
            su = normalize_social_url(href)
            if su != "N/A":
                if "instagram.com/" in su and res["ig"] == "N/A":
                    if is_valid_instagram_url(su):
                        res["ig"] = su
                if ("facebook.com/" in su or "fb.com/" in su) and res["fb"] == "N/A":
                    if is_valid_facebook_url(su):
                        res["fb"] = su
                if "tiktok.com/" in su and res["tk"] == "N/A":
                    if is_valid_tiktok_url(su):
                        res["tk"] = su
    except:
        pass
    return res

async def deep_website_probe(context, url):
    if not url or "N/A" in url or "google.com" in url:
        return "N/A", "N/A", "N/A", "N/A"
    # A Maps "website" is often only a Facebook/Instagram/TikTok profile.
    # Opening those pages wastes the visible browser session and does not help
    # discover a separate Instagram account. Social links are already captured
    # from Maps and are handled by the Instagram-only Google fallback below.
    if re.search(r"(?:facebook\.com|fb\.com|instagram\.com|tiktok\.com)/", url, re.I):
        return "N/A", "N/A", "N/A", "N/A"
    page = await context.new_page()
    out = {"emails": set(), "ig": "N/A", "fb": "N/A", "tk": "N/A"}
    try:
        await page.goto(url, timeout=30000, wait_until="domcontentloaded")
        await asyncio.sleep(3)
        d1 = await extract_socials(page)
        out["emails"].update(d1["emails"])
        out["ig"], out["fb"], out["tk"] = d1["ig"], d1["fb"], d1["tk"]
        contact = page.locator("a").filter(has_text=re.compile(r"Contact|About|Info|Reach|Booking", re.I))
        if await contact.count() > 0:
            href = await contact.first.get_attribute("href")
            if href:
                c_url = urllib.parse.urljoin(url, href)
                await page.goto(c_url, timeout=20000, wait_until="domcontentloaded")
                await asyncio.sleep(2)
                d2 = await extract_socials(page)
                out["emails"].update(d2["emails"])
                if out["ig"] == "N/A": out["ig"] = d2["ig"]
                if out["fb"] == "N/A": out["fb"] = d2["fb"]
                if out["tk"] == "N/A": out["tk"] = d2["tk"]
    except:
        pass
    finally:
        await page.close()
    return "; ".join(sorted(out["emails"])) if out["emails"] else "N/A", out["ig"], out["fb"], out["tk"]

# ==================== Google 搜索兜底（移植自 Universal） ====================
_social_search_count = 0
_social_search_blocked = False

async def google_search_instagram(context, shop_name: str, city: str, state: str, country: str):
    """Find one Instagram profile slowly, and stop searching after a challenge."""
    global _social_search_count, _social_search_blocked
    out_ig = "N/A"
    if _social_search_blocked:
        return out_ig

    delay = random.uniform(SOCIAL_SEARCH_DELAY_MIN, SOCIAL_SEARCH_DELAY_MAX) / 1000.0
    print(json.dumps({"type": "log", "message": f"Instagram search pacing: sleep {delay:.0f}s"}))
    await asyncio.sleep(delay)

    if _social_search_count and _social_search_count % max(1, SOCIAL_SEARCH_COOLDOWN_EVERY) == 0:
        cooldown = SOCIAL_SEARCH_COOLDOWN_MS / 1000.0
        print(json.dumps({"type": "log", "message": f"Instagram search cooldown: sleep {cooldown:.0f}s"}))
        await asyncio.sleep(cooldown)

    page = await context.new_page()
    try:
        query = f'site:instagram.com "{shop_name}" "{city}" {state} tattoo'
        encoded = urllib.parse.quote(query)
        url = f"https://www.google.com/search?q={encoded}&hl=en"
        await page.goto(url, wait_until="domcontentloaded", timeout=25000)
        _social_search_count += 1
        await asyncio.sleep(random.uniform(5.0, 9.0))

        if await detect_captcha(page):
            _social_search_blocked = True
            print(json.dumps({"type": "warn", "message": "Google verification detected; disabling Instagram fallback for this run"}))
            return out_ig

        links = await page.locator("a[href]").all()
        for a in links:
            href = await a.get_attribute("href")
            if not href:
                continue
            su = normalize_social_url(href)
            low = su.lower()
            if su != "N/A" and "instagram.com/" in low and not any(x in low for x in ["/p/", "/reel", "/explore"]):
                if is_valid_instagram_url(su):
                    out_ig = su
                    break
    except Exception as exc:
        print(json.dumps({"type": "warn", "message": f"Instagram search skipped: {type(exc).__name__}"}))
    finally:
        await page.close()
    return out_ig

# ==================== 页面滚动 ====================
async def ultra_slow_scroll(page):
    try:
        ov_tab = page.locator('button[role="tab"]').filter(has_text=re.compile(r"Overview", re.I))
        if await ov_tab.count() > 0 and await ov_tab.get_attribute("aria-selected") != "true":
            await ov_tab.click()
            await asyncio.sleep(1.5)
        title_loc = page.locator('h1.DUwDvf').first
        await title_loc.wait_for(state="visible", timeout=10000)
        box = await title_loc.bounding_box()
        if box:
            await page.mouse.click(box['x'] + 100, box['y'] + 10)
        for _ in range(45):
            await page.mouse.wheel(0, 380)
            await asyncio.sleep(0.8)
        await asyncio.sleep(3.5)
        for _ in range(12):
            await page.mouse.wheel(0, 220)
            await asyncio.sleep(0.8)
        await asyncio.sleep(2.0)
    except:
        pass

# ==================== 单城市抓取 ====================
async def scrape_city(page, context, city, done_shops, conn):
    city_query = normalize_city_input(city)
    search_query = f"{KEYWORD}+{city_query}, {STATE}, {COUNTRY}"
    encoded_query = urllib.parse.quote(search_query)
    search_url = f"https://www.google.com/maps/search/{encoded_query}?hl=en"
    print(json.dumps({"type": "log", "message": f"Searching: {search_query}"}))
    await page.goto(search_url, wait_until="domcontentloaded")
    await asyncio.sleep(8)

    # 限流 / 验证码检测：命中则立即退避，避免浪费后续请求
    if await detect_captcha(page):
        print(json.dumps({"type": "warn", "message": f"CAPTCHA/unusual-traffic on search: {search_query}"}))
        return -1

    if "/maps/place/" in page.url:
        urls = [page.url]
    else:
        await page.mouse.move(200, 500)
        for _ in range(8):
            await page.mouse.wheel(0, 3000)
            await asyncio.sleep(1.5)
        shop_links = await page.locator('a[href*="/maps/place/"]').all()
        urls = list(dict.fromkeys([await l.get_attribute("href") for l in shop_links if await l.get_attribute("href")]))

    if not urls:
        print(json.dumps({"type": "log", "message": f"No results for {city}"}))
        return 0

    shops_found = 0
    for url in urls:
        try:
            place_id = google_place_key(url)
            if place_id and f"place:{place_id}" in done_shops:
                print(json.dumps({"type": "log", "message": f"Skipped duplicate place: {url}"}))
                continue
            print(json.dumps({"type": "log", "message": f"Shop start: {url}"}))
            await page.goto(url, wait_until="commit", timeout=50000)
            await page.wait_for_selector('h1.DUwDvf', timeout=15000)
            name = (await page.locator('h1.DUwDvf').inner_text()).strip()
            shop_key = f"city:{normalize_string(name)}:{normalize_string(city)}"
            if shop_key in done_shops:
                print(json.dumps({"type": "log", "message": f"Skipped duplicate: {name}"}))
                continue

            data = {
                "name": name,
                "city": city,
                "address": "N/A",
                "phone": "N/A",
                "website": "N/A",
                "rating": 0,
                "reviewCount": 0,
                "instagram": "N/A",
                "facebook": "N/A",
                "tiktok": "N/A",
                "email": "N/A"
            }
            data["maps_place_id"] = place_id

            # 提取基本信息
            try:
                for sel in ['button[aria-label*="review"]', 'span[aria-label*="review"]', 'div[aria-label*="review"]']:
                    loc = page.locator(sel).first
                    if await loc.count() > 0:
                        aria = await loc.get_attribute("aria-label")
                        count = parse_review_count_from_text(aria or "")
                        if count > 0:
                            data["reviewCount"] = count
                            break
                if data["reviewCount"] == 0:
                    html = await page.content()
                    data["reviewCount"] = parse_review_count_from_text(html)
                addr_btn = page.locator('button[data-item-id="address"]').first
                if await addr_btn.count() > 0:
                    data["address"] = clean_text_field(await addr_btn.inner_text())
                phone_btn = page.locator('button[data-item-id^="phone:tel:"]').first
                if await phone_btn.count() > 0:
                    data["phone"] = clean_text_field(await phone_btn.inner_text())
                web_btn = page.locator('a[data-item-id="authority"]').first
                if await web_btn.count() > 0:
                    data["website"] = clean_url(await web_btn.get_attribute("href"))
                rating_el = page.locator('span[aria-label*="star"]').first
                if await rating_el.count() > 0:
                    aria = await rating_el.get_attribute("aria-label")
                    if aria:
                        m = re.search(r'[\d.]+', aria)
                        if m:
                            data["rating"] = float(m.group())
            except Exception as e:
                print(json.dumps({"type": "error", "message": f"Extract basic info error: {e}"}))

            # 区域过滤
            if not is_same_region(data.get("address", ""), STATE, COUNTRY):
                print(json.dumps({"type": "log", "message": f"Skip out-of-region: {name} | {data.get('address','')}"}))
                continue

            # 滚动加载
            scroll_timed_out = False
            try:
                await asyncio.wait_for(ultra_slow_scroll(page), timeout=45)
            except asyncio.TimeoutError:
                scroll_timed_out = True
                print(json.dumps({"type": "log", "message": f"Scroll timeout: {name} (continuing)"}))

            # 社交链接提取
            if not scroll_timed_out:
                socials = await extract_socials(page)
                data["instagram"] = socials["ig"]
                data["facebook"] = socials["fb"]
                data["tiktok"] = socials["tk"]
                if socials["emails"]:
                    data["email"] = "; ".join(sorted(socials["emails"]))

                # 额外等待后再试一次
                if data["instagram"] == "N/A" or data["facebook"] == "N/A" or data["tiktok"] == "N/A":
                    await asyncio.sleep(1.5)
                    socials2 = await extract_socials(page)
                    if data["instagram"] == "N/A" and socials2["ig"] != "N/A":
                        data["instagram"] = socials2["ig"]
                    if data["facebook"] == "N/A" and socials2["fb"] != "N/A":
                        data["facebook"] = socials2["fb"]
                    if data["tiktok"] == "N/A" and socials2["tk"] != "N/A":
                        data["tiktok"] = socials2["tk"]

            # Website probing is disabled by default. Maps retains the URL, while
            # social discovery uses a slow Google search to avoid opening every site.
            if WEBSITE_PROBE_ENABLED and data["website"] != "N/A":
                print(json.dumps({"type": "log", "message": f"Website probe: {name}"}))
                try:
                    em, ig, fb, tk = await asyncio.wait_for(deep_website_probe(context, data["website"]), timeout=25)
                except asyncio.TimeoutError:
                    em, ig, fb, tk = "N/A", "N/A", "N/A", "N/A"
                if data["email"] == "N/A" and em != "N/A":
                    data["email"] = em
                if data["instagram"] == "N/A" and ig != "N/A":
                    data["instagram"] = ig
                if data["facebook"] == "N/A" and fb != "N/A":
                    data["facebook"] = fb
                if data["tiktok"] == "N/A" and tk != "N/A":
                    data["tiktok"] = tk

            # Google fallback is reserved for the Instagram outreach pipeline.
            # Missing Facebook/TikTok alone must not trigger another browser search.
            if data["instagram"] == "N/A":
                print(json.dumps({"type": "log", "message": f"Google fallback: {name}"}))
                try:
                    f_ig = await asyncio.wait_for(
                        google_search_instagram(context, name, city, STATE, COUNTRY), timeout=300
                    )
                except asyncio.TimeoutError:
                    f_ig = "N/A"
                if data["instagram"] == "N/A" and f_ig != "N/A":
                    data["instagram"] = f_ig
                print(json.dumps({"type": "log", "message": f"Instagram fallback done: {name} | IG={data['instagram']}"}))

            # 最终 URL 质量验证
            if data["instagram"] != "N/A" and not is_valid_instagram_url(data["instagram"]):
                data["instagram"] = "N/A"
            if data["facebook"] != "N/A" and not is_valid_facebook_url(data["facebook"]):
                data["facebook"] = "N/A"
            if data["tiktok"] != "N/A" and not is_valid_tiktok_url(data["tiktok"]):
                data["tiktok"] = "N/A"

            # Cross-city duplicate guard. Google often returns the same physical
            # shop for nearby city searches, sometimes with a country suffix added.
            identity_keys = shop_identity_keys(data)
            if identity_keys.intersection(done_shops):
                print(json.dumps({"type": "log", "message": f"Skipped cross-city duplicate: {name}"}))
                done_shops.update(identity_keys)
                continue

            # 保存到 Neon DB（save_shop 自动重连，返回最新连接）
            try:
                conn = await save_shop(conn, data)
            except Exception as se:
                print(json.dumps({"type": "error", "message": f"DB save failed: {name} | {str(se)}"}))

            # 输出 CSV
            csv_row = {
                "Shop Name": data["name"],
                "Reviews": str(data["reviewCount"]),
                "Address": data["address"],
                "Phone": data["phone"],
                "Instagram": data["instagram"],
                "Facebook": data["facebook"],
                "TikTok": data["tiktok"],
                "Website": data["website"],
                "City": data["city"],
                "State": STATE,
                "Country": COUNTRY,
                "Email": data["email"],
                "Rating": str(data["rating"]),
                "Scraped At": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
            append_to_csv(csv_row)

            shops_found += 1
            done_shops.update(identity_keys)
            print(json.dumps({
                "type": "shop",
                "task_id": TASK_ID,
                "id": generate_shop_id(data["name"], data.get("address", ""), data.get("phone", ""), data.get("maps_place_id", "")),
                "city": data.get("city", ""),
                "shop_name": data.get("name", ""),
                "address": data.get("address", ""),
                "phone": data.get("phone", ""),
                "website": data.get("website", ""),
                "instagram": data.get("instagram", ""),
                "facebook": data.get("facebook", ""),
                "tiktok": data.get("tiktok", ""),
                "email": data.get("email", ""),
                "csv": MASTER_CSV
            }))
            print(json.dumps({
                "type": "log",
                "message": f"Saved: {name} | Reviews: {data['reviewCount']} | IG={data['instagram']} | FB={data['facebook']} | TK={data['tiktok']}"
            }))
        except Exception as e:
            print(json.dumps({"type": "error", "message": f"Error: {str(e)}"}))
            continue
    return shops_found

# ==================== 主流程 ====================
async def main():
    # --- register-only mode: seed a completed job from existing CSV, no scraping ---
    if REGISTER_ONLY:
        count = 0
        if os.path.exists(MASTER_CSV):
            try:
                with open(MASTER_CSV, encoding='utf-8-sig') as f:
                    count = sum(1 for _ in csv.DictReader(f))
            except Exception:
                pass
        jid = cloud_register()
        if jid:
            cloud_status('completed', cities_done=len(CITIES), cities_total=len(CITIES), artists_found=count)
            print(json.dumps({"type": "done", "message": f"Registered {STATE} as completed ({count} shops)", "job_id": jid}))
        else:
            print(json.dumps({"type": "error", "message": "register-only failed (cloud unreachable or job create failed)"}))
        return

    conn = await init_db()

    # 从 DB + CSV 双重查重
    db_rows = await conn.fetch('''
        SELECT shop_name, city, address, phone, ig_handle, dedupe_key, maps_place_id
        FROM artists WHERE source_type='maps_scrape' AND import_region=$1
    ''', STATE)
    done_shops = set()
    for row in db_rows:
        if row.get('dedupe_key'):
            done_shops.add(row['dedupe_key'])
        if row.get('maps_place_id'):
            done_shops.add(f"place:{str(row['maps_place_id']).lower()}")
        done_shops.update(shop_identity_keys({
            "name": row.get('shop_name'), "city": row.get('city'),
            "address": row.get('address'), "phone": row.get('phone'),
            "instagram": row.get('ig_handle'),
        }))
    csv_done_cities, csv_done_shops = load_finished()
    done_shops.update(csv_done_shops)

    # 按字母排序城市
    all_cities = sorted(CITIES, key=lambda x: normalize_string(x))

    # 过滤已完成城市
    task_cities = []
    start_idx = 0
    if args.start_from_city:
        n = normalize_string(args.start_from_city)
        for i, c in enumerate(all_cities):
            if normalize_string(c) == n:
                start_idx = i
                break
    for c in all_cities[start_idx:]:
        city_norm = normalize_string(c)
        if city_norm not in csv_done_cities:
            task_cities.append(c)

    # 已完成城市数（进度日志里已标记），用于让进度条从断点继续而不是归零
    completed_before = len(all_cities) - len(task_cities)

    print(json.dumps({
        "type": "init",
        "total_cities": len(all_cities),
        "task_cities": len(task_cities),
        "completed_before": completed_before,
        "first_city": task_cities[0] if task_cities else "NONE",
        "state": STATE,
        "country": COUNTRY,
        "csv": MASTER_CSV,
        "progress_log": PROGRESS_LOG
    }))

    # --- register / start cloud coverage job ---
    if CLOUD_BASE:
        cloud_register()
        if JOB_ID:
            # 进度以全州城市总数为分母，已完成的城市作为基数，续跑不让进度条回零
            cloud_status('running', cities_total=len(all_cities), cities_done=completed_before, artists_found=0)

    if not task_cities:
        if JOB_ID:
            cloud_status('completed', cities_done=len(all_cities), cities_total=len(all_cities), artists_found=len(done_shops))
        print(json.dumps({"type": "done", "message": "All cities already scraped", "total_shops": len(done_shops), "complete": True}))
        await conn.close()
        return

    async with async_playwright() as p:
        # 优先 CDP 连接已有 Chrome（和旧版 UT_Scanner 一样，稳定不崩）
        if CDP_URL:
            try:
                browser = await p.chromium.connect_over_cdp(CDP_URL)
                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                page = context.pages[0] if context.pages else await context.new_page()
                await page.set_viewport_size({"width": 1920, "height": 1080})
                print(json.dumps({"type": "log", "message": f"Connected CDP: {CDP_URL}"}))
            except Exception as e:
                print(json.dumps({"type": "error", "message": f"CDP connect failed: {str(e)}"}))
                if JOB_ID:
                    cloud_status('failed', error='CDP connect failed')
                await conn.close()
                return
        else:
            # 无 CDP 时自己启动（带稳定性参数）
            browser = await p.chromium.launch(
                headless=HEADLESS,
                args=[
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-default-browser-check',
                    '--disable-features=TranslateUI',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-sync',
                    '--disable-default-apps',
                    '--hide-scrollbars',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-sandbox',
                ]
            )
            context = await browser.new_context(
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                viewport={'width': 1920, 'height': 1080},
                locale='en-US',
            )
            page = await context.new_page()
            await page.add_init_script('''
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            ''')
            await page.set_viewport_size({"width": 1920, "height": 1080})
            print(json.dumps({"type": "log", "message": f"Launched Chromium (headless={HEADLESS})"}))

        total_found = 0
        success_count = 0
        had_error = False
        for idx, city in enumerate(task_cities):
            city_norm = normalize_string(city)

            # 检查浏览器连接（和旧版一样的检查逻辑）
            if not browser.is_connected():
                print(json.dumps({"type": "error", "message": f"Browser disconnected at {city}, aborting"}))
                had_error = True
                break

            print(json.dumps({
                "type": "progress", "phase": "start", "city": city,
                "current": completed_before + idx + 1, "total": len(all_cities), "shops_found": total_found
            }))
            try:
                found = await scrape_city(page, context, city, done_shops, conn)
                if found == -1:
                    # CAPTCHA / 限流：退避后重试一次
                    print(json.dumps({"type": "warn", "message": f"CAPTCHA at {city}; backing off {CAPTCHA_BACKOFF_MS//1000}s then retry"}))
                    await asyncio.sleep(captcha_backoff_seconds())
                    found = await scrape_city(page, context, city, done_shops, conn)
                if found == -1:
                    # 重试仍被挡：跳过该城（不标记完成，便于后续重跑重试），继续下一城
                    print(json.dumps({"type": "warn", "message": f"CAPTCHA persists at {city}; skipping for now"}))
                    had_error = True
                else:
                    total_found += found
                    success_count += 1
                    mark_city_scanned(city_norm)
                    if JOB_ID:
                        cloud_status('running', cities_done=completed_before + idx + 1, cities_total=len(all_cities), artists_found=total_found)
                    print(json.dumps({
                        "type": "progress", "phase": "end", "city": city,
                        "current": completed_before + idx + 1, "total": len(all_cities), "shops_found": found
                    }))
            except Exception as e:
                error_msg = str(e)
                print(json.dumps({"type": "error", "message": f"City error {city}: {error_msg}"}))
                # 断点续：城市级异常【不】标记完成，让该城下次续跑重试（已存店铺靠 done_shops 去重续抓）
                had_error = True
                if any(kw in error_msg.lower() for kw in ['target closed', 'browser closed', 'page crashed', 'connection closed', 'protocol error']):
                    print(json.dumps({"type": "error", "message": f"FATAL: Browser crash at {city}, aborting"}))
                    break
                continue
            # --- 城市间拟人延迟（避免 Google 限流 / 验证码）---
            d = city_delay_seconds()
            print(json.dumps({"type": "log", "message": f"Pacing: sleep {d:.0f}s before next city"}))
            await asyncio.sleep(d)
            # --- 每 N 城长冷却一次 ---
            if (idx + 1) % COOLDOWN_EVERY == 0 and (idx + 1) < len(task_cities):
                cd = cooldown_seconds()
                print(json.dumps({"type": "log", "message": f"Cooldown: sleep {cd:.0f}s after {idx+1} cities"}))
                await asyncio.sleep(cd)

    total_shops = (await conn.fetchval("SELECT COUNT(*) FROM artists WHERE source_type='maps_scrape' AND import_region=$1", STATE)) if conn else total_found
    if JOB_ID:
        # 有城市出错则保持 running（不标 completed），让调度器重新接管并从断点续跑；否则标 completed
        final_status = 'completed' if not had_error else 'running'
        cities_done_final = completed_before + success_count
        cloud_status(final_status, cities_done=cities_done_final, cities_total=len(all_cities), artists_found=total_shops)
    await conn.close()
    print(json.dumps({
        "type": "done",
        "total_shops": total_shops,
        "state": STATE,
        "csv": MASTER_CSV,
        "progress_log": PROGRESS_LOG,
        "complete": not had_error
    }))

if __name__ == "__main__":
    asyncio.run(main())
