"""
Composition Engine v1 — Visual Language Operating System
Not a vocabulary list. A composition system.

Given a product type or scene intent, the engine:
  - Selects appropriate camera / lighting / composition / materials / motion
  - Applies priority weights
  - Checks conflict rules
  - Generates structured prompts for image or video generation

Usage:
  from analyzer.composition_engine import CompositionEngine
  engine = CompositionEngine()
  result = engine.compose("tattoo_cartridge")
  print(result["image_prompt"])
"""

import json
import os
import random

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DICT_DIR = os.path.join(BASE_DIR, "dictionaries")

def _load_dict(name):
    path = os.path.join(DICT_DIR, f"{name}.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


class CompositionEngine:
    """Visual composition engine — maps product/scene types to optimal
    camera, lighting, composition, materials, and motion combinations.

    Priority weights:
      subject (40%) — the product is always the hero
      lighting (20%) — sets the mood and visibility
      material (15%) — surface quality defines realism
      composition (15%) — framing controls perception
      motion (10%) — only relevant for video
    """

    def __init__(self):
        self.camera_terms = _load_dict("camera_terms")
        self.lighting_terms = _load_dict("lighting_terms")
        self.materials_terms = _load_dict("materials_terms")
        self.composition_terms = _load_dict("composition_terms")
        self.motion_terms = _load_dict("motion_terms")
        self.style_terms = _load_dict("style_terms")
        self.visual_styles = _load_dict("visual_styles")

        # ── Composition Rules: product/scene → optimal visual choices ──
        self.composition_rules = {
            # ── Product shots ──
            "tattoo_cartridge": {
                "priority": "product_detail",
                "camera": ["macro close-up", "extreme macro", "detail shot"],
                "lighting": ["commercial product lighting", "soft diffused lighting",
                              "studio lighting", "rim lighting"],
                "composition": ["center composition", "subject isolation",
                                 "tight framing", "symmetrical balance"],
                "materials": ["plastic cartridge reflection", "transparent plastic texture",
                               "brushed metal", "chrome metallic reflection"],
                "motion": ["static shot", "still", "slow cinematic motion"],
                "style": ["commercial polished", "high end commercial", "clean minimalist"],
                "depth_of_field": ["shallow depth of field", "deep depth of field"],
                "angle_preference": ["side angle shot", "front angle shot", "top-down shot"],
                "conflicts": ["rough handheld", "dark tattoo studio",
                              "fast handheld motion", "documentary realism"],
            },
            "tattoo_machine": {
                "priority": "product_detail",
                "camera": ["cinematic close-up", "detail shot", "medium close-up"],
                "lighting": ["commercial product lighting", "dramatic shadow lighting",
                              "rim lighting", "studio lighting"],
                "composition": ["center composition", "subject isolation",
                                 "tight framing", "asymmetrical balance"],
                "materials": ["metal machine reflection", "brushed metal texture",
                               "soft matte plastic", "chrome metallic reflection"],
                "motion": ["static shot", "still", "machine startup motion"],
                "style": ["commercial polished", "industrial raw", "dark mood"],
                "depth_of_field": ["shallow depth of field"],
                "angle_preference": ["side angle shot", "front angle shot", "artist POV"],
                "conflicts": ["rough handheld", "vintage film",
                              "soft natural", "bright colorful"],
            },
            "tattoo_ink": {
                "priority": "color_and_label",
                "camera": ["macro close-up", "detail shot", "top-down shot"],
                "lighting": ["studio lighting", "commercial product lighting",
                              "soft diffused lighting", "back lighting"],
                "composition": ["center composition", "symmetrical balance",
                                 "tight framing", "foreground focus"],
                "materials": ["ink shine reflection", "glossy reflection",
                               "transparent plastic texture", "wet ink reflection"],
                "motion": ["static shot", "still"],
                "style": ["commercial polished", "bright clean", "clean minimalist"],
                "depth_of_field": ["shallow depth of field"],
                "angle_preference": ["front angle shot", "top-down shot", "side angle shot"],
                "conflicts": ["dark saturated", "rough handheld", "underground studio"],
            },
            "power_supply": {
                "priority": "product_detail",
                "camera": ["detail shot", "medium close-up", "front angle shot"],
                "lighting": ["studio lighting", "commercial product lighting",
                              "soft diffused lighting"],
                "composition": ["center composition", "symmetrical balance",
                                 "subject isolation"],
                "materials": ["brushed metal texture", "soft matte plastic",
                               "metal machine reflection"],
                "motion": ["static shot", "still"],
                "style": ["commercial polished", "clean minimalist", "high end commercial"],
                "depth_of_field": ["deep depth of field"],
                "angle_preference": ["front angle shot", "side angle shot"],
                "conflicts": ["rough handheld", "dark mood", "documentary realism"],
            },
            "grip": {
                "priority": "texture_and_ergonomics",
                "camera": ["macro close-up", "detail shot"],
                "lighting": ["soft diffused lighting", "studio lighting",
                              "rim lighting"],
                "composition": ["tight framing", "subject isolation",
                                 "asymmetrical balance"],
                "materials": ["soft matte plastic", "brushed metal texture",
                               "rubber grip texture"],
                "motion": ["static shot", "slow cinematic motion"],
                "style": ["commercial polished", "clean minimalist"],
                "depth_of_field": ["shallow depth of field"],
                "angle_preference": ["side angle shot", "front angle shot"],
                "conflicts": ["dark mood", "underground studio", "rough handheld"],
            },
            "needle_pack": {
                "priority": "packaging_and_label",
                "camera": ["macro close-up", "top-down shot", "detail shot"],
                "lighting": ["studio lighting", "commercial product lighting",
                              "soft diffused lighting"],
                "composition": ["center composition", "symmetrical balance",
                                 "tight framing"],
                "materials": ["paper texture", "plastic cartridge reflection",
                               "transparent plastic texture"],
                "motion": ["static shot", "still"],
                "style": ["commercial polished", "clean minimalist", "bright clean"],
                "depth_of_field": ["deep depth of field"],
                "angle_preference": ["top-down shot", "front angle shot"],
                "conflicts": ["dark mood", "rough handheld", "cinematic mood"],
            },
            "aftercare_product": {
                "priority": "clean_and_clinical",
                "camera": ["detail shot", "medium close-up", "top-down shot"],
                "lighting": ["clinical clean lighting", "soft diffused lighting",
                              "studio lighting"],
                "composition": ["center composition", "symmetrical balance",
                                 "clean minimal layout"],
                "materials": ["soft matte plastic", "paper texture", "clean smooth surface"],
                "motion": ["static shot", "still"],
                "style": ["clinical clean", "clean minimalist", "bright clean"],
                "depth_of_field": ["deep depth of field"],
                "angle_preference": ["top-down shot", "front angle shot"],
                "conflicts": ["dark mood", "industrial raw", "underground studio"],
            },

            # ── Scene / Environment ──
            "workstation": {
                "priority": "layout_and_lighting",
                "camera": ["workstation shot", "wide framing", "medium shot"],
                "lighting": ["tattoo workstation lighting", "overhead studio lighting",
                              "industrial lighting", "LED workstation lighting"],
                "composition": ["layered depth", "asymmetrical balance",
                                 "wide framing", "negative space"],
                "materials": ["industrial workstation texture", "used workstation texture",
                               "paper towel texture", "metal surface"],
                "motion": ["workflow motion", "tool handling motion", "real-time movement"],
                "style": ["industrial raw", "documentary realism", "raw authentic"],
                "depth_of_field": ["deep depth of field", "moderate depth of field"],
                "angle_preference": ["over-the-shoulder shot", "side angle shot", "artist POV"],
                "conflicts": ["high end commercial", "studio professional", "vintage film"],
            },
            "artist_lifestyle": {
                "priority": "mood_and_story",
                "camera": ["artist POV", "documentary camera style", "medium close-up"],
                "lighting": ["moody cinematic lighting", "dramatic shadow lighting",
                              "natural studio lighting"],
                "composition": ["asymmetrical balance", "negative space", "layered depth"],
                "materials": ["raw skin detail", "documentary realism texture",
                               "clinical clean texture"],
                "motion": ["documentary movement style", "handheld documentary",
                            "cinematic reveal movement"],
                "style": ["documentary realism", "raw authentic", "atmospheric moody",
                           "underground studio"],
                "depth_of_field": ["shallow depth of field", "selective focus"],
                "angle_preference": ["artist POV", "over-the-shoulder shot", "handheld shot"],
                "conflicts": ["commercial polished", "clean minimalist", "studio professional"],
            },
            "finished_tattoo": {
                "priority": "art_and_composition",
                "camera": ["portrait framing", "medium close-up", "detail shot"],
                "lighting": ["natural studio lighting", "soft diffused lighting",
                              "cinematic lighting"],
                "composition": ["subject isolation", "center composition",
                                 "tight framing", "asymmetrical balance"],
                "materials": ["realistic skin texture", "wet ink reflection",
                               "high detail pore texture"],
                "motion": ["static shot", "still", "slow cinematic motion"],
                "style": ["documentary realism", "artistic dramatic",
                           "high end commercial", "editorial cinematic"],
                "depth_of_field": ["shallow depth of field", "selective focus"],
                "angle_preference": ["front angle shot", "side angle shot", "artist POV"],
                "conflicts": ["rough handheld", "industrial lighting", "cold tone lighting"],
            },

            # ── Process / Motion ──
            "process_shot": {
                "priority": "action_and_motion",
                "camera": ["handheld shot", "cinematic close-up", "artist POV"],
                "lighting": ["tattoo workstation lighting", "dramatic shadow lighting",
                              "documentary lighting"],
                "composition": ["tight framing", "foreground focus", "asymmetrical balance"],
                "materials": ["realistic skin texture", "wet ink reflection",
                               "black nitrile glove texture", "clinical clean texture"],
                "motion": ["needle vibration", "wipe reveal", "skin stretching motion",
                            "ink dipping motion", "real-time movement"],
                "style": ["documentary realism", "raw authentic", "industrial raw"],
                "depth_of_field": ["shallow depth of field", "selective focus"],
                "angle_preference": ["artist POV", "over-the-shoulder shot", "handheld shot"],
                "conflicts": ["commercial polished", "clean minimalist", "studio professional"],
            },

            # ── Promotional ──
            "promotional": {
                "priority": "brand_and_energy",
                "camera": ["medium shot", "wide framing", "tracking shot"],
                "lighting": ["studio lighting", "commercial product lighting",
                              "high key lighting", "neon accent lighting"],
                "composition": ["center composition", "symmetrical balance",
                                 "wide framing", "negative space"],
                "materials": ["clean workstation texture", "clinical clean texture",
                               "professional studio surface"],
                "motion": ["cinematic reveal movement", "smooth tracking motion",
                            "slow cinematic motion"],
                "style": ["high end commercial", "commercial polished", "bright clean",
                           "editorial cinematic"],
                "depth_of_field": ["deep depth of field"],
                "angle_preference": ["front angle shot", "side angle shot", "tracking shot"],
                "conflicts": ["dark mood", "rough handheld", "underground studio",
                              "raw authentic"],
            },
        }

        # ── Conflict matrix: incompatible term pairs ──
        self.conflict_matrix = {
            "rough handheld": ["static shot", "still", "slow cinematic motion",
                                "locked down", "commercial polished"],
            "dark mood": ["bright clean", "high key lighting", "clinical clean",
                           "bright colorful", "studio professional"],
            "clinical clean": ["rough handheld", "underground studio",
                                "dark saturated", "industrial raw"],
            "underground studio": ["commercial polished", "high end commercial",
                                    "clinical clean", "studio professional"],
            "commercial polished": ["rough handheld", "documentary realism",
                                     "raw authentic", "handheld shot"],
            "macro close-up": ["wide framing", "medium shot", "tracking shot"],
            "extreme crop": ["wide framing", "symmetrical balance", "negative space"],
        }

    def _check_conflicts(self, selected, conflicts):
        """Check if any selected term conflicts with the rules."""
        for term in selected:
            if term in conflicts:
                return True, term
            # Check conflict matrix
            if term in self.conflict_matrix:
                blocked = self.conflict_matrix[term]
                for other in selected:
                    if other in blocked:
                        return True, f"{term} <-> {other}"
        return False, None

    def compose(self, scene_type, custom_bias=None):
        """Generate a composition for a scene type.

        Args:
            scene_type: str — one of the composition_rules keys
            custom_bias: dict — optional bias to override specific categories
                          e.g. {"lighting": ["rim lighting"]}

        Returns:
            dict with keys: scene_type, camera, lighting, composition,
                            materials, motion, style, depth_of_field,
                            angle, image_prompt, video_prompt, conflicts
        """
        if scene_type not in self.composition_rules:
            available = list(self.composition_rules.keys())
            return {"error": f"Unknown scene type '{scene_type}'. Available: {available}"}

        rules = self.composition_rules[scene_type]
        custom_bias = custom_bias or {}

        # ── Select with priority weighting ──
        def pick(category, key):
            if category in custom_bias:
                return random.choice(custom_bias[category])
            options = rules.get(key, [])
            return random.choice(options) if options else "unknown"

        camera = pick("camera", "camera")
        lighting = pick("lighting", "lighting")
        composition = pick("composition", "composition")
        material = pick("materials", "materials")
        motion = pick("motion", "motion")
        style = pick("style", "style")
        depth = pick("depth_of_field", "depth_of_field")
        angle = pick("angle", "angle_preference")

        # ── Conflict check ──
        selected = [camera, lighting, composition, material, motion, style, depth, angle]
        has_conflict, conflict_term = self._check_conflicts(selected, rules.get("conflicts", []))

        # ── Resolve conflicts by re-selecting the conflicting term ──
        attempts = 0
        while has_conflict and attempts < 5:
            # Re-pick the category that caused the conflict
            for category, key in [("camera","camera"), ("lighting","lighting"),
                                   ("composition","composition"), ("motion","motion"),
                                   ("style","style")]:
                if category in custom_bias:
                    continue
                old_val = locals()[category]
                # Filter out the conflicting term
                options = [o for o in rules.get(key, []) if o != old_val]
                if options:
                    locals()[category] = random.choice(options)
            selected = [camera, lighting, composition, material, motion, style, depth, angle]
            has_conflict, conflict_term = self._check_conflicts(selected, rules.get("conflicts", []))
            attempts += 1

        # ── Build image prompt ──
        priority_map = {
            "product_detail": "Product photography",
            "color_and_label": "Product photography with vibrant colors",
            "texture_and_ergonomics": "Macro texture photography",
            "packaging_and_label": "Packaging photography",
            "clean_and_clinical": "Clinical product photography",
            "layout_and_lighting": "Workspace photography",
            "mood_and_story": "Lifestyle photography",
            "art_and_composition": "Art photography",
            "brand_and_energy": "Commercial photography",
            "action_and_motion": "Action photography",
        }
        base_style = priority_map.get(rules.get("priority", "product_detail"), "Product photography")

        # Avoid doubling "composition" suffix (some values already contain it)
        comp_str = composition if composition.endswith("composition") else f"{composition} composition"
        image_prompt = (
            f"{base_style} of a {scene_type.replace('_', ' ')}, "
            f"{camera}, {angle}, "
            f"{lighting}, "
            f"{comp_str}, "
            f"{depth}, "
            f"{material} material, "
            f"{style} style"
        )

        # ── Build video prompt (adds motion) ──
        video_prompt = (
            f"{image_prompt}, "
            f"{motion}, cinematic quality"
        )

        # ── Generation keywords ──
        keywords = [camera, angle, lighting, composition, depth,
                     material, style, motion]

        result = {
            "scene_type": scene_type,
            "priority": rules.get("priority"),
            "camera": camera,
            "angle": angle,
            "lighting": lighting,
            "composition": composition,
            "depth_of_field": depth,
            "material": material,
            "motion": motion,
            "style": style,
            "conflict_resolved": has_conflict,
            "conflict_term": conflict_term if has_conflict else None,
            "image_prompt": image_prompt,
            "video_prompt": video_prompt,
            "keywords": keywords,
        }
        return result

    def list_scene_types(self):
        return list(self.composition_rules.keys())

    def get_rules(self, scene_type):
        return self.composition_rules.get(scene_type, None)

    def batch_compose(self, scene_types):
        return {st: self.compose(st) for st in scene_types}
