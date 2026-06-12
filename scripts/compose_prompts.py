import sys, os, json, random
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from analyzer.composition_engine import CompositionEngine

engine = CompositionEngine()

# Mix of scenes for diversity
scenes = [
    ("tattoo_cartridge", "产品展示"),
    ("tattoo_cartridge", "产品展示"),
    ("tattoo_cartridge", "产品展示"),
    ("tattoo_cartridge", "微距特写"),
    ("process_shot", "操作过程"),
    ("workstation", "工作台场景"),
    ("promotional", "宣传推广"),
]

# Custom biases to force diversity
biases = [
    {"camera": ["macro close-up"], "lighting": ["studio lighting"], "composition": ["center composition"]},
    {"camera": ["extreme macro"], "lighting": ["rim lighting"], "composition": ["tight framing"]},
    {"camera": ["detail shot"], "lighting": ["commercial product lighting"], "composition": ["subject isolation"], "angle_preference": ["side angle shot"]},
    {"camera": ["extreme macro"], "lighting": ["soft diffused lighting"], "composition": ["symmetrical balance"], "depth_of_field": ["shallow depth of field"]},
    {"camera": ["handheld shot"], "lighting": ["tattoo workstation lighting"], "composition": ["foreground focus"]},
    {"camera": ["workstation shot"], "lighting": ["overhead studio lighting"], "composition": ["layered depth"]},
    {"camera": ["medium shot"], "lighting": ["high key lighting"], "composition": ["negative space"]},
]

peach_brand = (
    "Peach brand tattoo cartridge: soft peach pink housing, "
    "brushed silver metal connector, premium quality, "
    "Peach logo visible on cartridge, "
)

print("=" * 70)
print("Peach Image Studio Prompt Pack — 多样化 prompt")
print("=" * 70)

for i, ((scene, label), bias) in enumerate(zip(scenes, biases), 1):
    result = engine.compose(scene, custom_bias=bias)
    base_prompt = result["image_prompt"]

    # Inject Peach brand into the prompt
    full_prompt = f"{peach_brand}{base_prompt}"

    print(f"\n{'─' * 70}")
    print(f"  [{i}] {label} — {scene}")
    print(f"{'─' * 70}")
    print(f"  {full_prompt}")
    print(f"  Keywords: {', '.join(result['keywords'][:5])}")
