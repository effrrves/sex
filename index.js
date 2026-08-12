import { getAccountBalance, placeOrder, fetchQuoteExternal } from "./webull.js";
import { decideTradeAction } from "./ai.js";
import { loadState, saveState, logTrade, checkCircuitBreaker, resetIfNewTradingDay } from "./state.js";

// --- 設定(必要に応じて env vars / wrangler.toml の [vars] に移してください) ---
const SYMBOL = "AAPL"; // まずは1銘柄で検証
const MAX_ORDER_QTY = 1; // 1回の注文で許容する最大株数(安全キャップ、AIの判断より優先)
const DEFAULT_DAILY_LOSS_LIMIT = 50; // ドル。env.DAILY_LOSS_LIMIT があればそちらを優先

function todayStrET() {
  // 米国東部時間ベースの日付文字列(日次リセット判定用の簡易実装)
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function runTradingCycle(env) {
  const log = [];

  // 1. 口座残高の取得(日次損益判定に使用)
  const accountId = env.WEBULL_ACCOUNT_ID; // 事前に Account List API で調べて secret/var に設定
  const balance = await getAccountBalance(env, accountId);
  const currentEquity = parseFloat(balance.total_cash_balance) + parseFloat(balance.total_unrealized_profit_loss || "0");

  // 2. 状態読み込み・日次リセット判定・サーキットブレーカー確認
  let state = await loadState(env);
  state = resetIfNewTradingDay(state, todayStrET());
  const dailyLossLimit = env.DAILY_LOSS_LIMIT ? parseFloat(env.DAILY_LOSS_LIMIT) : DEFAULT_DAILY_LOSS_LIMIT;
  state = checkCircuitBreaker(state, currentEquity, dailyLossLimit);

  if (state.halted) {
    log.push("HALTED: 日次損失上限に到達しているため新規発注をスキップします。");
    await saveState(env, state);
    return { log, halted: true };
  }

  // 3. 株価取得(現状はWebull APIに現在値エンドポイントがないため外部ソース)
  const quote = await fetchQuoteExternal(SYMBOL);
  log.push(`quote: ${SYMBOL} = ${quote.price} ${quote.currency}`);

  // 4. AIに判断させる
  const decision = await decideTradeAction(env, {
    symbol: SYMBOL,
    price: quote.price,
    position: state.position,
    dailyPnl: state.dailyPnl,
    cash: balance.total_cash_balance,
  });
  log.push(`AI decision: ${JSON.stringify(decision)}`);

  // 5. 安全キャップの適用(AIの判断よりこちらを優先)
  let quantity = Math.min(decision.quantity || 0, MAX_ORDER_QTY);
  if (decision.action === "SELL") {
    quantity = Math.min(quantity, state.position); // 保有株数を超える売りは出さない
  }

  // 6. 発注
  if (decision.action !== "HOLD" && quantity > 0) {
    const order = await placeOrder(env, {
      accountId,
      symbol: SYMBOL,
      side: decision.action,
      quantity,
    });
    log.push(`ORDER PLACED: ${JSON.stringify(order)}`);

    state.position += decision.action === "BUY" ? quantity : -quantity;
    await logTrade(env, { time: new Date().toISOString(), symbol: SYMBOL, ...decision, quantity, order });
  } else {
    log.push("action=HOLD または数量0のため発注なし");
  }

  await saveState(env, state);
  return { log, halted: false, decision };
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
      const state = await loadState(env);
      return Response.json(state);
    }
    return new Response("webull-trading-bot: /run で手動実行, /status で状態確認", { status: 200 });
  },
};
