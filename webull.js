// ウィブル証券 OpenAPI クライアント (Cloudflare Workers向け, 依存ライブラリなし)
//
// 公式SDKはPython専用でCloudflare Workers(JS)では使えないため、
// 公式ドキュメントの署名仕様に基づき HMAC-SHA1 署名をWeb Crypto APIで自前実装しています。
// 参照: https://developer.webull.co.jp/api-doc/develop/auth
//
// 注意: 2026年2月時点、日本向けAPIには「現在値(リアルタイム株価)」を取得するエンドポイントが
// 存在しません(instrument/listは銘柄メタ情報のみ)。そのため株価データは別ソースから取得する
// 必要があります(fetchQuoteExternal を参照/後続タスクで実装)。

const API_HOST = "api.webull.co.jp";
const BASE_URL = `https://${API_HOST}`;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function md5Upper(text) {
  // Web Crypto は MD5 非対応のため、簡易実装が必要。
  // Cloudflare Workers では 'node:crypto' の一部が使えるため、それを利用する。
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(text, "utf8").digest("hex").toUpperCase();
}

async function hmacSha1Base64(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function generateNonce() {
  return crypto.randomUUID().replace(/-/g, "");
}

function isoTimestampUTC() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// 署名対象文字列を生成(公式ドキュメントのアルゴリズムに準拠)
async function buildSignature({ appKey, appSecret, uri, queryParams, body, headers }) {
  const allKv = { ...queryParams, ...headers };
  const sortedKeys = Object.keys(allKv).sort();
  const s1 = sortedKeys.map((k) => `${k}=${allKv[k]}`).join("&");

  let s3;
  if (body && body.length > 0) {
    const s2 = await md5Upper(body);
    s3 = `${uri}&${s1}&${s2}`;
  } else {
    s3 = `${uri}&${s1}`;
  }

  const encoded = encodeURIComponent(s3);
  const signature = await hmacSha1Base64(`${appSecret}&`, encoded);
  return signature;
}

async function signedRequest({ env, method, uri, queryParams = {}, body = null }) {
  const appKey = env.WEBULL_APP_KEY;
  const appSecret = env.WEBULL_APP_SECRET;

  const headers = {
    "x-app-key": appKey,
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-version": "1.0",
    "x-signature-nonce": generateNonce(),
    "x-timestamp": isoTimestampUTC(),
    host: API_HOST,
  };

  const bodyStr = body ? JSON.stringify(body) : "";

  const signature = await buildSignature({
    appKey,
    appSecret,
    uri,
    queryParams,
    body: bodyStr,
    headers,
  });

  const qs = new URLSearchParams(queryParams).toString();
  const url = `${BASE_URL}${uri}${qs ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      "x-signature": signature,
      "Content-Type": "application/json",
    },
    body: bodyStr || undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Webull API error ${res.status}: ${text}`);
  }
  return json;
}

export async function getAccountList(env) {
  return signedRequest({ env, method: "GET", uri: "/openapi/account/list" });
}

export async function getAccountBalance(env, accountId) {
  return signedRequest({
    env,
    method: "GET",
    uri: "/openapi/account/balance",
    queryParams: { account_id: accountId },
  });
}

export async function getInstrument(env, symbols, category = "US_STOCK") {
  return signedRequest({
    env,
    method: "GET",
    uri: "/instrument/list",
    queryParams: { symbols, category },
  });
}

// 成行/指値注文を発注する
// side: "BUY" | "SELL"、orderType: "MARKET" | "LIMIT"
export async function placeOrder(env, { accountId, symbol, side, quantity, orderType = "MARKET", limitPrice = null, clientOrderId }) {
  const orderItem = {
    instrument_type: "EQUITY",
    client_order_id: clientOrderId ?? crypto.randomUUID().replace(/-/g, ""),
    symbol,
    market: "US",
    side,
    order_type: orderType,
    time_in_force: "DAY",
    quantity: String(quantity),
    entrust_type: "QTY",
    support_trading_session: "N",
    account_tax_type: "GENERAL",
  };
  if (orderType === "LIMIT" && limitPrice != null) {
    orderItem.limit_price = String(limitPrice);
  }

  return signedRequest({
    env,
    method: "POST",
    uri: "/openapi/account/orders/place",
    queryParams: { account_id: accountId },
    body: { account_id: accountId, new_orders: [orderItem] },
  });
}

// --- 株価取得(外部ソース) ---
// Webull JP OpenAPIには現在値取得エンドポイントがないため、暫定的に別ソースを使う。
// TODO: 実運用に耐えるデータソース(有料APIやWebullアプリ側の別エンドポイント等)に差し替えてください。
export async function fetchQuoteExternal(symbol) {
  // 例: 無料の遅延データで代用(15-20分遅延の可能性あり。リアルタイム性が必要な戦略には不向き)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Quote fetch failed: ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const price = result?.meta?.regularMarketPrice;
  if (price == null) throw new Error("Quote data not found in response");
  return { symbol, price, currency: result.meta.currency, timestamp: Date.now() };
}
