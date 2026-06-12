"""Peach Image Studio Prompt Pack — 基于实物图的 img2img prompt"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from analyzer.composition_engine import CompositionEngine

engine = CompositionEngine()

PROMPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "peach_prompts")
os.makedirs(PROMPTS_DIR, exist_ok=True)

# Available Peach product images
rl_images = sorted(os.listdir(os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "peach_products", "RL")))
cog_images = sorted(os.listdir(os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "peach_products", "COG")))

# Scene configs: [scene_type, label, bias_override]
configs = [
    ("tattoo_cartridge", "高冷商业风 — 纯黑背景", {"lighting": ["commercial product lighting"], "composition": ["center composition"], "camera": ["macro close-up"]}),
    ("tattoo_cartridge", "极致微距 — 针尖细节", {"camera": ["extreme macro"], "lighting": ["rim lighting"], "composition": ["tight framing"]}),
    ("tattoo_cartridge", "柔光产品展示 — 白背景", {"lighting": ["soft diffused lighting"], "composition": ["symmetrical balance"], "camera": ["detail shot"]}),
    ("process_shot", "上肤过程 — POV 视角", {"camera": ["handheld shot"], "lighting": ["tattoo workstation lighting"], "composition": ["foreground focus"]}),
    ("workstation", "工作台场景 — 搭配机器", {"camera": ["workstation shot"], "lighting": ["overhead studio lighting"], "composition": ["layered depth"]}),
    ("promotional", "品牌宣传 — 高级感", {"camera": ["medium shot"], "lighting": ["high key lighting"], "composition": ["negative space"]}),
    ("artist_lifestyle", "纹身师生活 — 氛围感", {"camera": ["artist POV"], "lighting": ["moody cinematic lighting"], "composition": ["asymmetrical balance"]}),
    ("tattoo_cartridge", "产品拆解 — 多个角度", {"camera": ["macro close-up"], "lighting": ["studio lighting"], "composition": ["dynamic"], "angle_preference": ["top-down shot"]}),
]

# Build prompt pack
prompts = []
for scene, label, bias in configs:
    result = engine.compose(scene, custom_bias=bias)
    prompt = result["image_prompt"]
    prompts.append({
        "scene": scene,
        "label": label,
        "prompt": prompt,
        "keywords": result["keywords"][:4],
        "camera": result["camera"],
        "lighting": result["lighting"],
        "composition": result["composition"],
    })

# Split into RL and COG packs
rl_pack = {
    "type": "RL外壳",
    "images": rl_images,
    "note": "标准外壳，适合所有产品展示、微距、商业风场景",
    "prompts": prompts,
}

cog_pack = {
    "type": "COG外壳",
    "images": cog_images,
    "note": "COG特殊外壳，展示品牌多样性",
    "prompts": prompts,
}

# Write output
output = {"generated_at": __import__("time").strftime("%Y-%m-%d %H:%M:%S"), "packs": [rl_pack, cog_pack]}
path = os.path.join(PROMPTS_DIR, "img2img_prompts.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(output, f, indent=2, ensure_ascii=False)

# Print in readable format
print("=" * 70)
print("Peach Image Studio Prompt Pack — 基于实物图的 img2img 方案")
print("=" * 70)

for pack_name, pack_images, pack_note in [("RL 外壳", rl_images, rl_pack["note"]), ("COG 外壳", cog_images, cog_pack["note"])]:
    print(f"\n{'─' * 70}")
    print(f"  {pack_name} ({len(pack_images)} 张) — {pack_note}")
    print(f"{'─' * 70}")
    for p in prompts:
        print(f"\n  [{prompts.index(p)+1}] {p['label']}")
        print(f"      Prompt: Peach brand tattoo cartridge, {p['camera']}, {p['lighting']}, {p['composition']}, {p['prompt']}")

print(f"\n{'─' * 70}")
print(f"\n  使用方法:")
print(f"  1. 打开 Image Studio")
print(f"  2. 选择一张 Peach 实物图作为源图")
print(f"  3. 选择图生图模式 (Image-to-Image)")
print(f"  4. 输入对应的 prompt")
print(f"  5. 生成 → 图片自动保存到 data/generated_samples/")
print(f"\n  完整 prompt 列表已保存到: {path}")
print(f"{'=' * 70}")
