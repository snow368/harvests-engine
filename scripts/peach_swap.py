"""
Qwen-Image-Edit: replace competitor needle with Peach brand cartridge.
Usage: ! python F:/inkflow app/InkFlow_Project/inkflow_harvests/scripts/peach_swap.py
"""
import json, base64, urllib.request, os, time

API_KEY = open(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")).read().split("SILICON_KEY=")[1].split("\n")[0].strip()

# Competitor image: OEM cartridge on skin
src = "F:/inkflow app/InkFlow_Project/inkflow_harvests/data/test_needle_batch/oem-odm-permanent-makeup-needles-high-quality-disposable-tattoo-cartridge-needles_210.jpg"
with open(src, "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

prompt = "Replace the tattoo needle cartridge with a Peach brand cartridge. Peach: soft peach pink housing, silver metal connector. Keep skin and background exactly the same."

payload = json.dumps({"model": "Qwen/Qwen-Image-Edit-2509", "image": f"data:image/jpeg;base64,{img_b64}", "prompt": prompt}).encode()
req = urllib.request.Request("https://api.siliconflow.cn/v1/images/generations", data=payload, headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"}, method="POST")
with urllib.request.urlopen(req, timeout=180) as resp:
    result = json.loads(resp.read())

url = result["images"][0]["url"]
req_img = urllib.request.Request(url)
with urllib.request.urlopen(req_img, timeout=60) as r:
    data = r.read()

out = f"F:/inkflow app/InkFlow_Project/inkflow_harvests/data/generated_samples/peach_swap_{int(time.time())}.png"
with open(out, "wb") as f:
    f.write(data)
print(f"OK -> {out} ({len(data)//1024}KB)")
