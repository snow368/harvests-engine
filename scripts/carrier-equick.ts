/**
 * 物流商适配器 —— 易快通 E-Quick / 巧捷 (美国专线)
 * API 文档: https://gitee.com/xis_co/print
 */

import crypto from 'node:crypto';

interface EquickConfig {
  appKey: string;
  appSecret: string;
  baseUrl: string;
  nonce: string;
  version: string;
  hubInCode: string;
}

interface Address {
  name: string; phone: string; company?: string;
  countryCode: string; state?: string; city?: string; zip?: string; address: string;
}

interface CreateOrderParams {
  orderNumber: string; receiver: Address;
  weight: number; length?: number; width?: number; height?: number;
  packType?: string; remark?: string;
  decValue?: number;
}

interface CreateOrderResult {
  success: boolean; waybillNumber: string; orderNumber: string;
  message?: string; labelUrl?: string;
}

async function getToken(config: EquickConfig): Promise<string> {
  const url = `${config.baseUrl}ois/order/getAuth?appKey=${config.appKey}&appSecret=${config.appSecret}`;
  const res = await fetch(url);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { throw new Error('[equick] getAuth failed: ' + text.slice(0, 100)); }
  if (body.result_code !== 0) throw new Error('[equick] getAuth failed: ' + body.message);
  // Return the token string (not wrapped in JSON)
  return body.body.token;
}

function disguiseToken(rawToken: string, nonce: string): string {
  const obj = JSON.stringify({ timestamp: Date.now(), nonce, token: rawToken });
  return Buffer.from(obj).toString('base64')
    .replace(/a/g, '-').replace(/c/g, '#').replace(/x/g, '^').replace(/M/g, '$');
}

function calcSign(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).sort();
  const str = keys
    .filter(k => params[k] && params[k].length > 0)
    .map(k => `${k}=${params[k]}`)
    .join('&');
  const b64 = Buffer.from(str).toString('base64');
  return crypto.createHash('md5').update(b64 + secret).digest('hex').toUpperCase();
}

export async function createOrder(
  config: EquickConfig,
  params: CreateOrderParams
): Promise<CreateOrderResult> {
  const rawToken = await getToken(config);
  const ts = String(Date.now());
  const disguisedToken = disguiseToken(rawToken, config.nonce);

  // Form data: only body1
  const body1 = JSON.stringify({
    platformType: 'ZYXT',
    referenceno: params.orderNumber,
    hubInCode: config.hubInCode,
    packType: params.packType || 'WPX',
    goodsType: '普货',
    weig: params.weight,
    reName: params.receiver.name,
    reTel: params.receiver.phone,
    reAddr: params.receiver.address,
    reCountryCode: params.receiver.countryCode,
    reState: params.receiver.state || '',
    reCity: params.receiver.city || '',
    reZip: params.receiver.zip || '',
    reCompany: params.receiver.company || '',
    currency: 'USD',
    decValue: params.decValue ?? 10,
    decValueCur: 'USD',
    remark: params.remark || '',
    pieces: [{
      pcs: 1, actual: params.weight / 1000,
      length: params.length || 10, width: params.width || 10, height: params.height || 10,
      referenceno: params.orderNumber,
    }],
  });

  // Sign calculation: form data + nonce + timestamp + token(original) + version
  const signParams: Record<string, string> = { body1, nonce: config.nonce, timestamp: ts, token: rawToken, version: config.version };
  const sign = calcSign(signParams, config.appSecret);

  // Headers: disguised token + sign + version
  const headers: Record<string, string> = { token: disguisedToken, sign, version: config.version };

  // Body: only body1 (other params go to sign only, not to form)
  const encoded = `body1=${encodeURIComponent(body1)}`;

  console.log(`[equick] POST ois/order/createOrder token=${rawToken.slice(0, 8)}... sign=${sign.slice(0, 8)}...`);

  const res = await fetch(`${config.baseUrl}ois/order/createOrder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: encoded,
  });
  const text = await res.text();
  let result: any;
  try { result = JSON.parse(text); } catch { return { success: false, waybillNumber: '', orderNumber: params.orderNumber, message: text.slice(0, 200) }; }

  if (result.result_code !== 0) {
    return { success: false, waybillNumber: '', orderNumber: params.orderNumber, message: `${result.message} (code=${result.result_code})` };
  }
  return {
    success: true,
    waybillNumber: result.body?.refno || result.body?.waybillNumber || '',
    orderNumber: params.orderNumber,
    labelUrl: result.body?.labelUrl,
  };
}
