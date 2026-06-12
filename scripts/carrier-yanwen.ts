/**
 * 物流商适配器 —— 燕文物流 (Yanwen)
 * API: https://open.yw56.com.cn/api/order
 * 文档: memory/yanwen-logistics-api.md
 */

import crypto from 'node:crypto';

interface YanwenConfig {
  userId: string;
  apiToken: string;
  baseUrl: string;
  channelId: string;
}

interface Address {
  name: string;
  phone: string;
  email?: string;
  company?: string;
  country: string;   // 国家二字码或ID
  state?: string;
  city?: string;
  zipCode?: string;
  address: string;
}

interface ParcelItem {
  goodsNameCh: string;
  goodsNameEn: string;
  price: number;
  hscode?: string;
  quantity: number;
  weight: number;    // g
  sku?: string;
}

interface CreateOrderParams {
  orderNumber: string;
  receiver: Address;
  sender: Address;
  items: ParcelItem[];
  totalWeight: number;   // g
  length?: number;       // cm
  width?: number;
  height?: number;
  hasBattery?: boolean;
  currency?: string;
  remark?: string;
}

interface CreateOrderResult {
  success: boolean;
  waybillNumber: string;
  orderNumber: string;
  message?: string;
}

function sign(params: Record<string, string>, apiToken: string): string {
  // 固定顺序: user_id + data + format + method + timestamp + version
  const order = ['user_id', 'data', 'format', 'method', 'timestamp', 'version'];
  const rawStr = order.map(k => params[k] || '').join('');
  const signStr = apiToken + rawStr + apiToken;
  return crypto.createHash('md5').update(signStr).digest('hex');
}

export async function createOrder(
  config: YanwenConfig,
  params: CreateOrderParams
): Promise<CreateOrderResult> {
  const timestamp = Date.now();
  const data = JSON.stringify({
    channelId: config.channelId,
    orderSource: 'portal',
    orderNumber: params.orderNumber,
    receiverInfo: {
      name: params.receiver.name,
      phone: params.receiver.phone,
      email: params.receiver.email || '',
      company: params.receiver.company || '',
      country: params.receiver.country,
      state: params.receiver.state || '',
      city: params.receiver.city || '',
      zipCode: params.receiver.zipCode || '',
      address: params.receiver.address,
    },
    parcelInfo: {
      productList: params.items.map(item => ({
        goodsNameCh: item.goodsNameCh,
        goodsNameEn: item.goodsNameEn,
        price: item.price.toFixed(2),
        priceExport: item.price.toFixed(2),
        hscode: item.hscode || '',
        quantity: item.quantity,
        weight: item.weight,
        sku: item.sku || '',
      })),
      hasBattery: params.hasBattery ? 1 : 0,
      currency: params.currency || 'USD',
      totalQuantity: params.items.reduce((s, i) => s + i.quantity, 0),
      totalWeight: params.totalWeight,
      height: params.height || 0,
      width: params.width || 0,
      length: params.length || 0,
    },
    senderInfo: {
      name: params.sender.name,
      phone: params.sender.phone,
      email: params.sender.email || '',
      company: params.sender.company || '',
      country: params.sender.country || 'CN',
      state: params.sender.state || '',
      city: params.sender.city || '',
      zipCode: params.sender.zipCode || '',
      address: params.sender.address,
    },
    remark: params.remark || '',
  });

  const urlParams: Record<string, string> = {
    user_id: config.userId,
    method: 'express.order.create',
    format: 'json',
    timestamp: String(timestamp),
    version: 'V1.0',
    data,
  };
  urlParams.sign = sign(urlParams, config.apiToken);

  const query = Object.entries(urlParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const url = `${config.baseUrl}?${query}`;
  console.log(`[yanwen] POST ${url.slice(0, 120)}...`);

  const res = await fetch(url, { method: 'POST' });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { success: false, message: text.slice(0, 200) }; }

  if (!body.success) {
    return { success: false, waybillNumber: '', orderNumber: params.orderNumber, message: body.message };
  }
  return {
    success: true,
    waybillNumber: body.data?.waybillNumber || '',
    orderNumber: body.data?.orderNumber || params.orderNumber,
  };
}
