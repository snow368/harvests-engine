/**
 * 订单备注解析器 —— 提取赠品信息
 * 规则: 针型号 + 其他赠品
 * 针格式: [数字][数字][RL/RS/RG/RT/F/M]
 *   如: 1003RL (10号/03针/圆针), 1209RS (12号/09针/圆弯针)
 * 赠品: 小海报, 贴纸, 海报等
 */

export interface GiftItem {
  type: 'needle' | 'poster' | 'sticker' | 'unknown';
  label: string;
  quantity: number;
  /** 推测的盒数（每盒10支针） */
  estimatedBoxes?: number;
}

// 针型匹配: 4-6位数字 + RL/RS/RG/RT/F/M
const NEEDLE_PATTERN = /\b(\d{3,4})(RL|RS|RG|RT|F|M)\b/gi;

// 常见赠品关键词
const GIFT_KEYWORDS: Array<{ pattern: RegExp; type: GiftItem['type']; label: string }> = [
  { pattern: /小海报/gi, type: 'poster', label: '小海报' },

  { pattern: /贴纸/gi, type: 'sticker', label: '贴纸' },
  { pattern: / sticker/i, type: 'sticker', label: 'Sticker' },
];

// 套餐匹配: "套餐尺寸" 后面的针型号
const SET_PATTERN = /套餐尺寸(.+)/gi;

export function parseOrderNote(note: string): GiftItem[] {
  if (!note) return [];
  const gifts: GiftItem[] = [];
  const seen = new Set<string>();

  // 清理: 去掉 IG 链接
  const cleanNote = note.replace(/https?:\/\/[^\s]+/gi, '').trim();

  // 1. 匹配针型号
  let match;
  while ((match = NEEDLE_PATTERN.exec(cleanNote)) !== null) {
    const key = match[0].toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      gifts.push({
        type: 'needle',
        label: match[0],
        quantity: 1,
        estimatedBoxes: 1, // 默认1盒
      });
    }
  }

  // 2. 匹配赠品关键词
  for (const kw of GIFT_KEYWORDS) {
    if (kw.pattern.test(cleanNote)) {
      const key = kw.label;
      if (!seen.has(key)) {
        seen.add(key);
        gifts.push({
          type: kw.type,
          label: kw.label,
          quantity: 1,
        });
      }
    }
  }

  // 3. 套餐检测
  const setMatch = SET_PATTERN.exec(cleanNote);
  if (setMatch) {
    // 套餐标记: 里面的针已在第1步匹配到
    // 如果没有任何针匹配，标记为套装
    if (gifts.filter(g => g.type === 'needle').length === 0) {
      // 可能有未识别的针型号，标记为套餐
    }
  }

  return gifts;
}
