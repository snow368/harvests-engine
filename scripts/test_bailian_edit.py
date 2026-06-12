"""
百炼 Qwen-Image-Edit-Max 图生图测试
上传 Peach 产品图 → 换背景/风格，看能不能保住产品

用法:
  python scripts/test_bailian_edit.py
  python scripts/test_bailian_edit.py --style dark
  python scripts/test_bailian_edit.py --dry-run
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
API_KEY = "sk-3bc1604a4d1b41c0b5ab0a6ea6dfe664"
MODEL = "qwen-image-edit-max"
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "data", "generated_samples")
os.makedirs(OUTPUT_DIR, exist_ok=True)

def p(text):
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode('utf-8', errors='replace').decode('gbk', errors='replace'))

def encode_image(path):
    with open(path, "rb") as f:
        return f"data:image/jpeg;base64,{base64.b64encode(f.read()).decode()}"

def find_image():
    for d in ["RL", "COG", "new_photos"]:
        dp = os.path.join(PROJECT_ROOT, "data", "peach_products", d)
        if os.path.isdir(dp):
            files = sorted([f for f in os.listdir(dp) if f.lower().endswith(('.png','.jpg','.jpeg'))])
            if files: return os.path.join(dp, files[0])
    return None

STYLES = {
    "default": "将背景替换为专业摄影棚场景，柔光渐变背景。保持产品外观、颜色、品牌标识完全不变。",
    "dark": "将背景替换为暗调奢华风格，黑色渐变背景，戏剧性轮廓光。保持产品外观、颜色、品牌标识完全不变。",
    "studio": "将背景替换为明亮商业摄影棚，纯白背景，柔光。保持产品外观、颜色、品牌标识完全不变。",
    "flatlay": "将构图改为俯拍平铺，浅色大理石台面，自然柔光。保持产品外观、颜色、品牌标识完全不变。",
    "warm": "将背景替换为暖色调工作室，蜜桃粉色渐变背景，温暖柔和光线。保持产品外观、颜色、品牌标识完全不变。",
}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", help="Peach 产品图路径")
    parser.add_argument("--style", choices=list(STYLES.keys()), default="default")
    parser.add_argument("--custom-prompt", help="自定义编辑指令")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    img = args.image or find_image()
    if not img or not os.path.exists(img):
        p("[ERROR] 找不到产品图")
        sys.exit(1)

    prompt = args.custom_prompt or STYLES[args.style]

    p(f"[Input]  {os.path.basename(img)}")
    p(f"[Model]  {MODEL}")
    p(f"[Style]  {args.style}")
    p(f"\n{'='*60}")
    p("[PROMPT]")
    p(f"{'='*60}")
    p(prompt)
    p(f"{'='*60}")

    if args.dry_run:
        sys.exit(0)

    image_data_uri = encode_image(img)
    p(f"\n[Upload] {len(image_data_uri)//1024} KB")

    payload = {
        "model": MODEL,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"image": image_data_uri},
                        {"text": prompt},
                    ],
                }
            ]
        },
        "parameters": {
            "n": 1,
            "prompt_extend": False,  # 关掉改写，精准控制
            "watermark": False,
            "seed": 42,
            "size": "1024*1024",
        },
    }

    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
        method="POST",
    )

    p("[Call] 正在生成...")
    start = time.time()

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        p(f"\n[ERROR] HTTP {e.code}: {body}")
        sys.exit(1)
    except Exception as e:
        p(f"\n[ERROR] {e}")
        sys.exit(1)

    elapsed = time.time() - start
    p(f"\n[DONE] {elapsed:.1f}s")
    p(f"[Response] {json.dumps(result)[:500]}")

    # 百炼返回: output.choices[0].message.content[0].image
    img_url = None
    try:
        img_url = result["output"]["choices"][0]["message"]["content"][0]["image"]
    except (KeyError, IndexError, TypeError):
        try:
            img_url = result["output"]["results"][0]["url"]
        except:
            pass
        try:
            img_url = result["data"][0]["url"]
        except:
            pass

    if not img_url:
        p(f"[ERROR] 没找到图片URL: {json.dumps(result, ensure_ascii=False)[:300]}")
        sys.exit(1)

    # 下载
    req_img = urllib.request.Request(img_url)
    with urllib.request.urlopen(req_img, timeout=60) as r:
        img_data = r.read()

    ts = int(time.time())
    out = os.path.join(OUTPUT_DIR, f"peach_bailian_{args.style}_{ts}.png")
    with open(out, "wb") as f:
        f.write(img_data)

    p(f"[Save]  {os.path.relpath(out, PROJECT_ROOT)} ({len(img_data)//1024} KB)")

if __name__ == "__main__":
    main()
