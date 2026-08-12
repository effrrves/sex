// KVに保存する取引状態の管理
// キー構成:
//   state:current      -> { position, cash, dailyPnl, dailyStartEquity, lastUpdated, tradingDate, halted }
//   history:{timestamp} -> 個別の取引ログ(任意、デバッグ用)

const STATE_KEY = "state:current";

export async function loadState(env) {
  const raw = await env.TRADING_STATE.get(STATE_KEY, "json");
  if (raw) return raw;

  // 初期状態(初回起動時)
  return {
    position: 0, // 保有株数
    cash: 0, // 未使用: 実際の資金はWebull側の口座残高を都度取得する想定
    dailyPnl: 0,
    dailyStartEquity: null,
    tradingDate: null, // "YYYY-MM-DD" (米国東部時間ベースで管理推奨)
    halted: false, // true の間は新規発注をスキップ
    lastUpdated: null,
  };
}

export async function saveState(env, state) {
  state.lastUpdated = new Date().toISOString();
  await env.TRADING_STATE.put(STATE_KEY, JSON.stringify(state));
}

export async function logTrade(env, trade) {
  const key = `history:${Date.now()}`;
  await env.TRADING_STATE.put(key, JSON.stringify(trade));
}

// 1日の最大損失額(ドル)を超えたら halted = true にして以降の新規発注を止める。
// DAILY_LOSS_LIMIT は wrangler secret / vars で設定してください(未設定時は安全側でデフォルト値を使用)。
export function checkCircuitBreaker(state, currentEquity, dailyLossLimit) {
  if (state.dailyStartEquity == null) {
    state.dailyStartEquity = currentEquity;
  }

  state.dailyPnl = currentEquity - state.dailyStartEquity;

  if (!state.halted && state.dailyPnl <= -Math.abs(dailyLossLimit)) {
    state.halted = true;
    console.warn(
      `[CIRCUIT BREAKER] 日次損失上限(${dailyLossLimit})に到達。以降の新規発注を停止します。dailyPnl=${state.dailyPnl}`
    );
  }

  return state;
}

// 日付が変わったら(米国東部時間ベース)日次カウンタをリセット
export function resetIfNewTradingDay(state, todayStr) {
  if (state.tradingDate !== todayStr) {
    state.tradingDate = todayStr;
    state.dailyStartEquity = null;
    state.dailyPnl = 0;
    state.halted = false;
  }
  return state;
}
