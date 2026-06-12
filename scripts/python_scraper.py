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
import argparse
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
args = parser.parse_args()

STATE = args.state
COUNTRY = args.country
HEADLESS = args.headless.lower() == 'true'
KEYWORD = args.keyword
TASK_ID = args.task_id
CDP_URL = (args.cdp_url or '').strip()
OUTPUT_DIR = args.output_dir
STATE_TAG = re.sub(r'[^a-zA-Z0-9]', '', STATE).upper()

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
    "tv", "about", "developer", "directory", "legal", "privacy", "api"
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

def generate_shop_id(name, address, phone):
    raw = f"{name}_{address}_{phone}".lower()
    raw = re.sub(r'[^a-z0-9]+', '_', raw)
    return f"maps_{raw}"[:120]

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
    u = url.strip()
    if "/url?q=" in u:
        try:
            u = urllib.parse.unquote(u.split("/url?q=")[1].split("&")[0])
        except:
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
    if handle in {"meta", "instagram"}:
        return False
    return True

def is_valid_facebook_url(url: str) -> bool:
    u = str(url or "").strip().lower()
    if not u or ("facebook.com/" not in u and "fb.com/" not in u):
        return False
    bad_tokens = ["/login", "/profile.php", "/sharer", "/plugins", "/help", "/privacy", "/policies"]
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
    """Load set of already-scraped cities from CSV and progress log"""
    done_cities = set()
    done_shops = set()
    if os.path.exists(MASTER_CSV):
        try:
            with open(MASTER_CSV, 'r', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    city = normalize_string(row.get('City', ''))
                    shop = normalize_string(row.get('Shop Name', ''))
                    if city:
                        done_cities.add(city)
                    if shop and city:
                        done_shops.add(f"{shop}_{city}")
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
        print(json.dumps({"type": "log", "message": "Neon DB connected"}))
        return conn
    except Exception as e:
        print(json.dumps({"type": "error", "message": f"DB connect failed (CSV mode only): {str(e)[:200]}"}))
        return None

async def save_shop(conn, shop):
    shop_id = generate_shop_id(shop['name'], shop.get('address', ''), shop.get('phone', ''))
    rating_int = int(round(shop.get('rating', 0)))
    await conn.execute('''
        INSERT INTO artists (id, uid, username, full_name, shop_name, stage,
                             rating, reviews, address, phone, website,
                             ig_handle, facebook, tiktok, email, city,
                             source_type, entity_type, import_region, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW())
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
            rating = EXCLUDED.rating,
            reviews = EXCLUDED.reviews,
            last_updated = NOW()
    ''', shop_id, UID,
        shop['name'].replace(' ', '_').lower(), shop['name'], shop['name'], 'outreach',
        rating_int, shop.get('reviewCount', 0), shop.get('address'), shop.get('phone'), shop.get('website'),
        shop.get('instagram'), shop.get('facebook'), shop.get('tiktok'), shop.get('email'), shop['city'],
        'maps_scrape', 'tattoo_shop', STATE)

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
async def google_search_social(context, shop_name: str, state: str, country: str):
    """Fallback: Google search when Maps doesn't expose social links"""
    out_ig, out_fb, out_tk = "N/A", "N/A", "N/A"
    page = await context.new_page()
    try:
        async def run_query(q: str):
            encoded = urllib.parse.quote(q)
            url = f"https://www.google.com/search?q={encoded}&hl=en"
            await page.goto(url, wait_until="domcontentloaded", timeout=25000)
            await asyncio.sleep(2.2)
            links = await page.locator("a[href]").all()
            found_ig, found_fb, found_tk = "N/A", "N/A", "N/A"
            for a in links:
                href = await a.get_attribute("href")
                if not href:
                    continue
                su = normalize_social_url(href)
                if su == "N/A":
                    continue
                low = su.lower()
                if found_ig == "N/A" and "instagram.com/" in low and not any(x in low for x in ["/p/", "/reel", "/explore"]):
                    if is_valid_instagram_url(su):
                        found_ig = su
                if found_fb == "N/A" and ("facebook.com/" in low or "fb.com/" in low) and not any(x in low for x in ["/sharer", "/plugins"]):
                    if is_valid_facebook_url(su):
                        found_fb = su
                if found_tk == "N/A" and "tiktok.com/" in low:
                    if is_valid_tiktok_url(su):
                        found_tk = su
                if found_ig != "N/A" and found_fb != "N/A" and found_tk != "N/A":
                    break
            return found_ig, found_fb, found_tk

        q1 = f"{shop_name} {state} {country} instagram facebook tiktok"
        ig1, fb1, tk1 = await run_query(q1)
        if ig1 != "N/A": out_ig = ig1
        if fb1 != "N/A": out_fb = fb1
        if tk1 != "N/A": out_tk = tk1

        if out_tk == "N/A":
            q2 = f"{shop_name} tattoo {state} tiktok"
            ig2, fb2, tk2 = await run_query(q2)
            if out_ig == "N/A" and ig2 != "N/A": out_ig = ig2
            if out_fb == "N/A" and fb2 != "N/A": out_fb = fb2
            if tk2 != "N/A": out_tk = tk2
    except:
        pass
    finally:
        await page.close()
    return out_ig, out_fb, out_tk

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
            print(json.dumps({"type": "log", "message": f"Shop start: {url}"}))
            await page.goto(url, wait_until="commit", timeout=50000)
            await page.wait_for_selector('h1.DUwDvf', timeout=15000)
            name = (await page.locator('h1.DUwDvf').inner_text()).strip()
            shop_key = f"{normalize_string(name)}_{normalize_string(city)}"
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

            # 网站探测
            if data["website"] != "N/A":
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

            # Google 搜索兜底（关键改进！加 TikTok）
            if data["instagram"] == "N/A" or data["facebook"] == "N/A" or data["tiktok"] == "N/A":
                print(json.dumps({"type": "log", "message": f"Google fallback: {name}"}))
                try:
                    f_ig, f_fb, f_tk = await asyncio.wait_for(
                        google_search_social(context, name, STATE, COUNTRY), timeout=30
                    )
                except asyncio.TimeoutError:
                    f_ig, f_fb, f_tk = "N/A", "N/A", "N/A"
                if data["instagram"] == "N/A" and f_ig != "N/A":
                    data["instagram"] = f_ig
                if data["facebook"] == "N/A" and f_fb != "N/A":
                    data["facebook"] = f_fb
                if data["tiktok"] == "N/A" and f_tk != "N/A":
                    data["tiktok"] = f_tk
                print(json.dumps({"type": "log", "message": f"Fallback done: {name} | IG={data['instagram']} | FB={data['facebook']} | TK={data['tiktok']}"}))

            # 最终 URL 质量验证
            if data["instagram"] != "N/A" and not is_valid_instagram_url(data["instagram"]):
                data["instagram"] = "N/A"
            if data["facebook"] != "N/A" and not is_valid_facebook_url(data["facebook"]):
                data["facebook"] = "N/A"
            if data["tiktok"] != "N/A" and not is_valid_tiktok_url(data["tiktok"]):
                data["tiktok"] = "N/A"

            # 保存到 Neon DB
            try:
                await save_shop(conn, data)
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
            done_shops.add(shop_key)
            print(json.dumps({
                "type": "shop",
                "task_id": TASK_ID,
                "id": generate_shop_id(data["name"], data.get("address", ""), data.get("phone", "")),
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
    conn = await init_db()

    # 从 DB + CSV 双重查重
    db_rows = await conn.fetch("SELECT id FROM artists WHERE source_type='maps_scrape' AND import_region=$1", STATE)
    done_shops = {row['id'] for row in db_rows}
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

    print(json.dumps({
        "type": "init",
        "total_cities": len(all_cities),
        "task_cities": len(task_cities),
        "first_city": task_cities[0] if task_cities else "NONE",
        "state": STATE,
        "country": COUNTRY,
        "csv": MASTER_CSV,
        "progress_log": PROGRESS_LOG
    }))

    if not task_cities:
        print(json.dumps({"type": "done", "message": "All cities already scraped", "total_shops": len(done_shops)}))
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
        for idx, city in enumerate(task_cities):
            city_norm = normalize_string(city)

            # 检查浏览器连接（和旧版一样的检查逻辑）
            if not browser.is_connected():
                print(json.dumps({"type": "error", "message": f"Browser disconnected at {city}, aborting"}))
                break

            print(json.dumps({
                "type": "progress", "phase": "start", "city": city,
                "current": idx + 1, "total": len(task_cities), "shops_found": total_found
            }))
            try:
                found = await scrape_city(page, context, city, done_shops, conn)
                total_found += found
                mark_city_scanned(city_norm)
                print(json.dumps({
                    "type": "progress", "phase": "end", "city": city,
                    "current": idx + 1, "total": len(task_cities), "shops_found": found
                }))
            except Exception as e:
                error_msg = str(e)
                print(json.dumps({"type": "error", "message": f"City error {city}: {error_msg}"}))
                mark_city_scanned(city_norm)
                if any(kw in error_msg.lower() for kw in ['target closed', 'browser closed', 'page crashed', 'connection closed', 'protocol error']):
                    print(json.dumps({"type": "error", "message": f"FATAL: Browser crash at {city}, aborting"}))
                    break
                continue
            await asyncio.sleep(random.uniform(2, 4))

    total_shops = await conn.fetchval("SELECT COUNT(*) FROM artists WHERE source_type='maps_scrape' AND import_region=$1", STATE)
    await conn.close()
    print(json.dumps({
        "type": "done",
        "total_shops": total_shops,
        "state": STATE,
        "csv": MASTER_CSV,
        "progress_log": PROGRESS_LOG
    }))

if __name__ == "__main__":
    asyncio.run(main())
