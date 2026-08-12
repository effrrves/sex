import { getAccountBalance, placeOrder, fetchQuoteExternal } from "./webull.js";
import { decideTradeAction } from "./ai.js";
import {
  loadAccountState,
  saveAccountState,
  loadSymbolState,
  saveSymbolState,
  logTrade,
  checkCircuitBreaker,
  resetIfNewTradingDay,
} from "./state.js";

// --- 設定(必要に応じて env vars / wrangler.toml の [vars] に移してください) ---
// 銘柄はCloudflareの Variables and Secrets で SYMBOLS="AAPL,MSFT,GOOGL" のようにカンマ区切りで指定できます。
// 未設定の場合は DEFAULT_SYMBOLS が使われます。
const DEFAULT_SYMBOLS = ["AAPL"];
const MAX_ORDER_QTY = 1; // 1回の注文で許容する最大株数(安全キャップ、AIの判断より優先)
const DEFAULT_DAILY_LOSS_LIMIT = 50; // ドル(口座全体)。env.DAILY_LOSS_LIMIT があればそちらを優先

function todayStrET() {
  // 米国東部時間ベースの日付文字列(日次リセット判定用の簡易実装)
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function getSymbols(env) {
  if (env.SYMBOLS) {
    return env.SYMBOLS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  return DEFAULT_SYMBOLS;
}

// 1銘柄分の判断・発注を行う。口座レベルのサーキットブレーカーは呼び出し元で確認済みの前提。
async function runSymbolCycle(env, symbol, { balance, accountState }) {
  const log = [];

  const symbolState = await loadSymbolState(env, symbol);

  const quote = await fetchQuoteExternal(symbol);
  log.push(`[${symbol}] quote: ${quote.price} ${quote.currency}`);

  const decision = await decideTradeAction(env, {
    symbol,
    price: quote.price,
    position: symbolState.position,
    dailyPnl: accountState.dailyPnl,
    cash: balance.total_cash_balance,
  });
  log.push(`[${symbol}] AI decision: ${JSON.stringify(decision)}`);

  let quantity = Math.min(decision.quantity || 0, MAX_ORDER_QTY);
  if (decision.action === "SELL") {
    quantity = Math.min(quantity, symbolState.position); // 保有株数を超える売りは出さない
  }

  if (decision.action !== "HOLD" && quantity > 0) {
    const accountId = env.WEBULL_ACCOUNT_ID;
    const order = await placeOrder(env, {
      accountId,
      symbol,
      side: decision.action,
      quantity,
    });
    log.push(`[${symbol}] ORDER PLACED: ${JSON.stringify(order)}`);

    symbolState.position += decision.action === "BUY" ? quantity : -quantity;
    await logTrade(env, { time: new Date().toISOString(), symbol, ...decision, quantity, order });
  } else {
    log.push(`[${symbol}] action=HOLD または数量0のため発注なし`);
  }

  await saveSymbolState(env, symbol, symbolState);
  return { symbol, log, decision };
}

async function runTradingCycle(env) {
  const log = [];
  const symbols = getSymbols(env);

  // 1. 口座残高の取得(日次損益判定に使用。全銘柄で共通)
  const accountId = env.WEBULL_ACCOUNT_ID;
  const balance = await getAccountBalance(env, accountId);
  const currentEquity = parseFloat(balance.total_cash_balance) + parseFloat(balance.total_unrealized_profit_loss || "0");

  // 2. 口座レベルの状態読み込み・日次リセット判定・サーキットブレーカー確認
  let accountState = await loadAccountState(env);
  accountState = resetIfNewTradingDay(accountState, todayStrET());
  const dailyLossLimit = env.DAILY_LOSS_LIMIT ? parseFloat(env.DAILY_LOSS_LIMIT) : DEFAULT_DAILY_LOSS_LIMIT;
  accountState = checkCircuitBreaker(accountState, currentEquity, dailyLossLimit);

  if (accountState.halted) {
    log.push("HALTED: 日次損失上限に到達しているため、全銘柄で新規発注をスキップします。");
    await saveAccountState(env, accountState);
    return { log, halted: true, symbols: [] };
  }

  await saveAccountState(env, accountState);

  // 3. 銘柄ごとに判断・発注(直列実行。銘柄数が増えたら並列化やレート制限考慮が必要)
  const results = [];
  for (const symbol of symbols) {
    try {
      const result = await runSymbolCycle(env, symbol, { balance, accountState });
      results.push(result);
      log.push(...result.log);
    } catch (err) {
      log.push(`[${symbol}] ERROR: ${err.message}`);
      console.error(`Symbol cycle failed for ${symbol}:`, err);
      // 1銘柄の失敗で他銘柄の処理を止めない
    }
  }

  return { log, halted: false, symbols: results };
}

export default {
  // Cron Triggerから1分毎に呼ばれる
  async scheduled(event, env, ctx) {
    try {
      const result = await runTradingCycle(env);
      console.log(result.log.join("\n"));
    } catch (err) {
      console.error("Trading cycle failed:", err);
      // TODO: 失敗を検知したら通知(Slack/メール等)を飛ばす仕組みを追加推奨
    }
  },

  // 手動実行・動作確認用(本番で公開する場合は認証を追加してください)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      try {
        const result = await runTradingCycle(env);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }
    if (url.pathname === "/status") {
      const symbols = getSymbols(env);
      const accountState = await loadAccountState(env);
      const symbolStates = {};
      for (const symbol of symbols) {
        symbolStates[symbol] = await loadSymbolState(env, symbol);
      }
      return Response.json({ account: accountState, symbols: symbolStates });
    }
    return new Response("webull-trading-bot: /run で手動実行, /status で状態確認", { status: 200 });
  },
};
