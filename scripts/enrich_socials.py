#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
社媒链接补全脚本 — Google 搜索 + 多候选打分
读取 CSV，对缺 IG/FB/TK 的店铺逐条搜索，写入 CSV 的增强版
"""
import asyncio
import urllib.parse
import re
import os
import json
import csv
import sys
from pathlib import Path
from playwright.async_api import async_playwright

# ========== 自动加载 .env ==========
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

# ========== 参数 ==========
INPUT_CSV = sys.argv[1] if len(sys.argv) > 1 else r'D:\MyCrawler_System\Data\Raw_Leads\WA_Raw.csv'
OUTPUT_CSV = INPUT_CSV.replace('.csv', '_enriched.csv')
CDP_URL = os.environ.get('CDP_URL', 'http://127.0.0.1:9222')
HEADLESS = os.environ.get('HEADLESS', 'false').lower() == 'true'

# ========== 候选打分 ==========
def normalize(s):
    return re.sub(r'[^a-zA-Z0-9]', '', str(s)).lower()

def tokenize(s):
    return set(re.findall(r'[a-zA-Z0-9]{3,}', str(s).lower()))

def score_instagram(url, shop_name, city, state, snippet=""):
    """对 IG 候选链接打分（0-100）"""
    if not url or 'N/A' in url:
        return 0
    # 提取 handle
    m = re.search(r'instagram\.com/([a-zA-Z0-9._-]+)', url)
    if not m:
        return 0
    handle = m.group(1)
    # 排除非 profile 路径
    if handle in ('p', 'reel', 'explore', 'accounts', 'stories', 'reels'):
        return 0

    score = 0
    shop_tokens = tokenize(shop_name)
    handle_lower = handle.lower().replace('.', '').replace('_', '')
    blob = f"{handle_lower} {snippet.lower()}"

    # 1. handle 包含店名关键词（最强信号）
    matches = sum(1 for t in shop_tokens if t in handle_lower)
    score += matches * 25

    # 2. 地理位置匹配
    if city and normalize(city) in normalize(blob):
        score += 20
    if state and normalize(state) in normalize(blob):
        score += 10

    # 3. snippet 包含 tattoo/ink/piercing 纹身信号
    tattoo_signals = ['tattoo', 'ink', 'piercing', 'tatu', 'tat2']
    if any(s in blob for s in tattoo_signals):
        score += 15

    # 4. handle 长度合理（太短可能是抢注号，太长可能是假号）
    if 5 <= len(handle) <= 30:
        score += 5

    # 5. 不含可疑词
    bad_words = ['shop', 'store', 'buy', 'sale', 'officialpage', 'fan', 'fake']
    if any(w in handle_lower for w in bad_words):
        score -= 20

    return min(100, max(0, score))


def score_facebook(url, shop_name, city, state, snippet=""):
    if not url or 'N/A' in url:
        return 0
    m = re.search(r'(?:facebook\.com|fb\.com)/([a-zA-Z0-9._-]+)', url)
    if not m:
        return 0
    handle = m.group(1)
    # 排除非 page 路径
    skip = ('sharer', 'plugins', 'share', 'login', 'groups', 'photo', 'video', 'permalink', 'story', 'tr')
    if handle.lower() in skip:
        return 0

    score = 0
    shop_tokens = tokenize(shop_name)
    handle_lower = handle.lower().replace('.', '').replace('_', '')
    matches = sum(1 for t in shop_tokens if t in handle_lower)
    score += matches * 25
    if city and normalize(city) in normalize(snippet.lower()):
        score += 20
    if state and normalize(state) in normalize(snippet.lower()):
        score += 10
    tattoo_signals = ['tattoo', 'ink', 'piercing', 'tatu']
    if any(s in f"{handle_lower} {snippet.lower()}" for s in tattoo_signals):
        score += 15
    if 5 <= len(handle) <= 40:
        score += 5
    return min(100, max(0, score))


def score_tiktok(url, shop_name, city, state, snippet=""):
    if not url or 'N/A' in url:
        return 0
    m = re.search(r'tiktok\.com/@?([a-zA-Z0-9._-]+)', url)
    if not m:
        return 0
    handle = m.group(1)
    skip = ('music', 'tag', 'sound', 'trending', 'explore', 'live', 'embed')
    if handle.lower() in skip:
        return 0

    score = 0
    shop_tokens = tokenize(shop_name)
    handle_lower = handle.lower().replace('.', '').replace('_', '')
    matches = sum(1 for t in shop_tokens if t in handle_lower)
    score += matches * 25
    if city and normalize(city) in normalize(snippet.lower()):
        score += 20
    if 5 <= len(handle) <= 30:
        score += 5
    return min(100, max(0, score))


# ========== Google 搜索（多候选版） ==========
async def google_search_all(context, shop_name, city, state):
    """搜索并返回所有候选 + 打分，不再遇到第一个就收"""
    candidates = {'ig': [], 'fb': [], 'tk': []}
    page = await context.new_page()
    try:
        queries = [
            f"{shop_name} {city} {state} instagram",
            f"{shop_name} {city} {state} facebook",
            f"{shop_name} {city} {state} tiktok",
        ]
        for q in queries:
            url = f"https://www.google.com/search?q={urllib.parse.quote(q)}&hl=en"
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=20000)
                await asyncio.sleep(2.5)
            except:
                continue

            links = await page.locator("a[href]").all()
            for a in links:
                href = await a.get_attribute("href")
                if not href:
                    continue
                # 提取 Google 搜索结果里的真实 URL
                su = normalize_social_url(href)
                if su == "N/A":
                    continue

                low = su.lower()
                # 收集 IG 候选
                if "instagram.com/" in low:
                    s = score_instagram(su, shop_name, city, state)
                    if s >= 10:
                        candidates['ig'].append((su, s))
                # 收集 FB 候选
                if "facebook.com/" in low or "fb.com/" in low:
                    s = score_facebook(su, shop_name, city, state)
                    if s >= 10:
                        candidates['fb'].append((su, s))
                # 收集 TK 候选
                if "tiktok.com/" in low:
                    s = score_tiktok(su, shop_name, city, state)
                    if s >= 10:
                        candidates['tk'].append((su, s))
    finally:
        await page.close()

    # 去重 + 排序 + 取最佳
    def pick_best(cands):
        seen = set()
        unique = []
        for url, score in cands:
            key = normalize(url)[:50]
            if key not in seen:
                seen.add(key)
                unique.append((url, score))
        unique.sort(key=lambda x: -x[1])
        if unique:
            best_url, best_score = unique[0]
            confidence = 'high' if best_score >= 50 else ('medium' if best_score >= 25 else 'low')
            return best_url, confidence
        return 'N/A', 'none'

    return {
        'ig': pick_best(candidates['ig']),
        'fb': pick_best(candidates['fb']),
        'tk': pick_best(candidates['tk']),
    }


def normalize_social_url(href):
    """从 Google 搜索结果 href 中提取真实社媒链接"""
    if not href:
        return "N/A"
    # Google 包装链接: /url?q=https://...
    if '/url?q=' in href:
        try:
            decoded = urllib.parse.unquote(href.split('/url?q=')[1].split('&')[0])
            return decoded.split('?')[0].rstrip('/')
        except:
            pass
    # 直接链接
    if href.startswith('http'):
        return href.split('?')[0].rstrip('/')
    return "N/A"


def is_valid_url(url, platform):
    if not url or url == 'N/A':
        return False
    patterns = {
        'ig': re.compile(r'^https?://(?:www\.)?instagram\.com/[a-zA-Z0-9._-]+$'),
        'fb': re.compile(r'^https?://(?:www\.)?(?:facebook\.com|fb\.com)/[a-zA-Z0-9._-]+$'),
        'tk': re.compile(r'^https?://(?:www\.)?tiktok\.com/@?[a-zA-Z0-9._-]+$'),
    }
    pat = patterns.get(platform)
    return bool(pat and pat.match(url))


# ========== 主流程 ==========
async def main():
    # 读 CSV
    with open(INPUT_CSV, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    print(f"读取 {len(rows)} 条记录")

    # 筛选需要补全的
    needs_ig = [r for r in rows if not r.get('Instagram') or r['Instagram'] == 'N/A']
    needs_fb = [r for r in rows if not r.get('Facebook') or r['Facebook'] == 'N/A']
    needs_tk = [r for r in rows if not r.get('TikTok') or r.get('TikTok', 'N/A') == 'N/A']
    need_set = set()
    for r in needs_ig + needs_fb + needs_tk:
        need_set.add(r.get('Shop Name', '') + '|' + r.get('City', ''))

    if not need_set:
        print("所有记录社媒已齐全，无需补全")
        return

    print(f"缺 IG: {len(needs_ig)} | 缺 FB: {len(needs_fb)} | 缺 TK: {len(needs_tk)}")
    print(f"去重后需处理: {len(need_set)} 家店\n")

    async with async_playwright() as p:
        if CDP_URL:
            try:
                browser = await p.chromium.connect_over_cdp(CDP_URL)
                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                print(f"[OK] CDP 连接: {CDP_URL}")
            except Exception as e:
                print(f"[ERR] CDP 失败: {e}")
                return
        else:
            browser = await p.chromium.launch(headless=HEADLESS)
            context = await browser.new_context(
                viewport={'width': 1920, 'height': 1080},
                locale='en-US',
            )

        enriched = 0
        total = len(rows)
        for idx, row in enumerate(rows):
            name = row.get('Shop Name', '')
            city = (row.get('City', '') or '').replace(', WA', '').split(',')[0].strip()
            state = row.get('State', 'WA') or 'WA'

            ig_current = row.get('Instagram', 'N/A')
            fb_current = row.get('Facebook', 'N/A')
            tk_current = row.get('TikTok', 'N/A')

            # 三项都有的跳过
            if (ig_current and ig_current != 'N/A' and
                fb_current and fb_current != 'N/A' and
                tk_current and tk_current != 'N/A'):
                continue

            print(f"[{idx+1}/{total}] {name} ({city})", end=' ')
            try:
                results = await google_search_all(context, name, city, state)

                changed = []
                if (not ig_current or ig_current == 'N/A') and results['ig'][0] != 'N/A':
                    row['Instagram'] = results['ig'][0]
                    changed.append(f"IG={results['ig'][0]} ({results['ig'][1]})")
                if (not fb_current or fb_current == 'N/A') and results['fb'][0] != 'N/A':
                    row['Facebook'] = results['fb'][0]
                    changed.append(f"FB={results['fb'][0]} ({results['fb'][1]})")
                if (not tk_current or tk_current == 'N/A') and results['tk'][0] != 'N/A':
                    row['TikTok'] = results['tk'][0]
                    changed.append(f"TK={results['tk'][0]} ({results['tk'][1]})")

                if changed:
                    enriched += 1
                    print(f"[OK] {' | '.join(changed)}")
                else:
                    print("[SKIP] 未找到")
            except Exception as e:
                print(f"[ERR] 错误: {str(e)[:100]}")

            await asyncio.sleep(1.5)  # 反爬

    # 写回 CSV
    fieldnames = list(rows[0].keys())
    with open(OUTPUT_CSV, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"\n[DONE] 增强: {enriched}/{total} | 输出: {OUTPUT_CSV}")


if __name__ == "__main__":
    asyncio.run(main())
