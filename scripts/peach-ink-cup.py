#!/usr/bin/env python3
"""
Peach Ink Cup Generator — 空色料杯 → 装满墨水 + Kwadron 风格背景

用法: python3 scripts/peach-ink-cup.py
输出: output/peach_ink_cup/

生成 3 个 Peach 品牌配色变体（粉/绿/PMU透明）+ 1 个黑色
背景自动套 Kwadron 风格
"""
import os
import sys
import time
import json
import urllib.request
import urllib.error
from pathlib import Path

# ─── 配置 ───
API_KEY = os.getenv('REPLICATE_API_KEY', '').strip()
PROXY = os.getenv('PROXY', 'socks5://127.0.0.1:7890')
MODEL = 'black-forest-labs/flux-1.1-pro-ultra'
OUTPUT_DIR = Path(__file__).parent.parent / 'Peach_AI_System' / 'engine' / 'output' / 'peach_ink_cup'

def make_proxy():
    from urllib.request import ProxyHandler, build_opener
    # 去掉 socks5 用 http 代理，或用系统代理
    import socket
    socket.setdefaulttimeout(180)
    return build_opener()

def api_request(url, data=None, method='POST'):
    """调用 Replicate API"""
    import http.client
    from urllib.parse import urlparse
    
    parsed = urlparse(url)
    headers = {
        'Authorization': f'Bearer {API_KEY}',
        'Content-Type': 'application/json',
    }
    body = json.dumps(data).encode() if data else None
    if body:
        headers['Content-Length'] = str(len(body))
    
    print(f"  POST {url} ({len(body) if body else 0} bytes)")
    
    try:
        import http.client
        conn = http.client.HTTPSConnection('api.replicate.com', timeout=180)
        conn.request(method, url, body=body, headers=headers)
        resp = conn.getresponse()
        result = resp.read().decode()
        conn.close()
        return json.loads(result) if result else {}
    except Exception as e:
        print(f"  API Error: {e}")
        return None

def download_image(url, dest_path):
    """下载图片到本地"""
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        })
        urllib.request.urlretrieve(req, dest_path)
        size = os.path.getsize(dest_path)
        print(f"  ↓ Saved: {dest_path} ({size/1024:.0f} KB)")
        return True
    except Exception as e:
        print(f"  Download Error: {e}")
        return False

def generate_image(prompt, name, wait=True):
    """生成一张图片"""
    print(f"\n{'='*60}")
    print(f"Generating: {name}")
    print(f"Prompt: {prompt[:120]}...")
    
    # 创建prediction
    data = {
        'input': {
            'prompt': prompt,
            'aspect_ratio': '4:3',
            'safety_tolerance': 5,
            'raw': False,
            'output_format': 'png',
        }
    }
    
    result = api_request(
        f'/v1/models/{MODEL}/predictions',
        data=data
    )
    
    if not result:
        print("  ✗ No response from API")
        return False
    
    # 检查是否直接返回成功
    if result.get('status') == 'succeeded' and result.get('output'):
        url = result['output'][0] if isinstance(result['output'], list) else result['output']
        dest = OUTPUT_DIR / f"{name.replace(' ', '_')}.png"
        if download_image(url, str(dest)):
            return True
    
    # 需要轮询
    if result.get('urls', {}).get('get'):
        poll_url = result['urls']['get']
        print("  Queued. Polling...")
        
        for i in range(60):
            time.sleep(3)
            status_result = api_request(poll_url, method='GET')
            
            if not status_result:
                continue
                
            status = status_result.get('status', 'unknown')
            print(f"  [{i+1}] {status}")
            
            if status == 'succeeded':
                url = status_result['output'][0] if isinstance(status_result.get('output'), list) else status_result.get('output')
                dest = OUTPUT_DIR / f"{name.replace(' ', '_')}.png"
                if download_image(url, str(dest)):
                    return True
            elif status == 'failed':
                print(f"  ✗ Failed: {json.dumps(status_result).strip()[:200]}")
                return False
    
    print("  ✗ Timeout or error")
    return False

def main():
    # Kwadron 风格通用描述
    kwadron_style = (
        "Professional product photography, hard light from upper left creating sharp highlights, "
        "pure black to dark blue gradient background with no texture, "
        "high contrast cool tones with metallic edge glow, precision industrial aesthetic, "
        "shallow depth of field, studio quality, photorealistic, "
        "no text, no watermark, no labels."
    )
    
    prompts = [
        {
            'name': 'pink_ink_kwadron',
            'prompt': (
                f"A small white silicone ink cup filled with vibrant peach pink liquid tattoo ink, "
                f"ink surface with soft glossy reflection, matte silicone texture, "
                f"{kwadron_style}"
            )
        },
        {
            'name': 'green_ink_kwadron',
            'prompt': (
                f"A small white silicone ink cup filled with vibrant mint green liquid tattoo ink, "
                f"ink surface with soft glossy reflection, matte silicone texture, "
                f"{kwadron_style}"
            )
        },
        {
            'name': 'pmu_clear_ink_kwadron',
            'prompt': (
                f"A small white silicone ink cup filled with translucent light pink PMU pigment ink, "
                f"delicate sheer appearance, soft glossy ink surface, "
                f"{kwadron_style}"
            )
        },
        {
            'name': 'black_ink_kwadron',
            'prompt': (
                f"A small white silicone ink cup filled with deep black tattoo ink, "
                f"ink surface highly reflective and glossy, "
                f"{kwadron_style}"
            )
        },
    ]
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    for p in prompts:
        ok = generate_image(p['prompt'], p['name'])
        time.sleep(3)  # 避免太快
    
    print(f"\n{'='*60}")
    print(f"Done! Output directory: {OUTPUT_DIR}")
    print(f"Files: {list(OUTPUT_DIR.iterdir())}")

if __name__ == '__main__':
    main()
