// KVに保存する取引状態の管理
// キー構成:
//   state:account          -> { dailyPnl, dailyStartEquity, tradingDate, halted, lastUpdated }
//                              (口座全体の状態。日次損益・サーキットブレーカーは銘柄をまたいで共通)
//   state:symbol:{SYMBOL}  -> { position, lastUpdated } (銘柄ごとの保有株数)
//   history:{timestamp}    -> 個別の取引ログ(任意、デバッグ用)

const ACCOUNT_STATE_KEY = "state:account";
const symbolStateKey = (symbol) => `state:symbol:${symbol}`;

export async function loadAccountState(env) {
  const raw = await env.TRADING_STATE.get(ACCOUNT_STATE_KEY, "json");
  if (raw) return raw;

  return {
    dailyPnl: 0,
    dailyStartEquity: null,
    tradingDate: null, // "YYYY-MM-DD" (米国東部時間ベース)
    halted: false, // true の間は全銘柄で新規発注をスキップ
    lastUpdated: null,
  };
}

export async function saveAccountState(env, state) {
  state.lastUpdated = new Date().toISOString();
  await env.TRADING_STATE.put(ACCOUNT_STATE_KEY, JSON.stringify(state));
}

export async function loadSymbolState(env, symbol) {
  const raw = await env.TRADING_STATE.get(symbolStateKey(symbol), "json");
  if (raw) return raw;
  return { position: 0, lastUpdated: null };
}

export async function saveSymbolState(env, symbol, state) {
  state.lastUpdated = new Date().toISOString();
  await env.TRADING_STATE.put(symbolStateKey(symbol), JSON.stringify(state));
}

export async function logTrade(env, trade) {
  const key = `history:${Date.now()}:${trade.symbol ?? "unknown"}`;
  await env.TRADING_STATE.put(key, JSON.stringify(trade));
}

// 1日の最大損失額(ドル、口座全体)を超えたら halted = true にして以降の新規発注を全銘柄で止める。
// DAILY_LOSS_LIMIT は wrangler secret / vars で設定してください(未設定時は安全側でデフォルト値を使用)。
export function checkCircuitBreaker(accountState, currentEquity, dailyLossLimit) {
  if (accountState.dailyStartEquity == null) {
    accountState.dailyStartEquity = currentEquity;
  }

  accountState.dailyPnl = currentEquity - accountState.dailyStartEquity;

  if (!accountState.halted && accountState.dailyPnl <= -Math.abs(dailyLossLimit)) {
    accountState.halted = true;
    console.warn(
      `[CIRCUIT BREAKER] 日次損失上限(${dailyLossLimit})に到達。以降の新規発注を全銘柄で停止します。dailyPnl=${accountState.dailyPnl}`
    );
  }

  return accountState;
}

// 日付が変わったら(米国東部時間ベース)日次カウンタをリセット
export function resetIfNewTradingDay(accountState, todayStr) {
  if (accountState.tradingDate !== todayStr) {
    accountState.tradingDate = todayStr;
    accountState.dailyStartEquity = null;
    accountState.dailyPnl = 0;
    accountState.halted = false;
  }
  return accountState;
}
