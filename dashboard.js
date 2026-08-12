// 成績・保有ポジション・取引履歴を確認するダッシュボード画面(HTML)
// 同じCloudflare Worker内の /api/summary と /api/history を叩いて表示する。
// ビルド不要のシンプルな1ファイル構成。

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>取引ダッシュボード</title>
<style>
  :root {
    --bg: #0f1115;
    --card: #171a21;
    --border: #262a33;
    --text: #e6e8eb;
    --muted: #8a8f98;
    --green: #3ecf8e;
    --red: #f0616d;
    --accent: #7c9cff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
  }
  h1 { font-size: 20px; margin: 0 0 20px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
  }
  .card .label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .card .value { font-size: 22px; font-weight: 600; }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .halted-banner {
    background: #3a1f22;
    border: 1px solid var(--red);
    color: var(--red);
    padding: 10px 14px;
    border-radius: 8px;
    margin-bottom: 20px;
    font-size: 14px;
    display: none;
  }
  section { margin-bottom: 28px; }
  h2 { font-size: 15px; color: var(--muted); font-weight: 500; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  tr:hover td { background: #1c1f27; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge.buy { background: rgba(62,207,142,0.15); color: var(--green); }
  .badge.sell { background: rgba(240,97,109,0.15); color: var(--red); }
  .empty { color: var(--muted); font-size: 13px; padding: 12px 0; }
  .refresh-note { color: var(--muted); font-size: 12px; margin-top: 8px; }
  .pos-table td.qty-pos { color: var(--green); }
  .pos-table td.qty-zero { color: var(--muted); }
</style>
</head>
<body>
  <h1>取引ダッシュボード</h1>
  <div id="halted-banner" class="halted-banner">⛔ 日次損失上限に到達しているため、現在は新規発注を停止中です</div>

  <div class="grid" id="summary-cards"></div>

  <section>
    <h2>保有ポジション</h2>
    <table class="pos-table">
      <thead><tr><th>銘柄</th><th>保有株数</th></tr></thead>
      <tbody id="positions-body"></tbody>
    </table>
    <div id="positions-empty" class="empty" style="display:none;">保有ポジションはありません</div>
  </section>

  <section>
    <h2>取引履歴(新しい順)</h2>
    <table>
      <thead><tr><th>日時</th><th>銘柄</th><th>売買</th><th>数量</th><th>約定時株価</th><th>判断理由</th></tr></thead>
      <tbody id="history-body"></tbody>
    </table>
    <div id="history-empty" class="empty" style="display:none;">取引履歴はまだありません</div>
  </section>

  <div class="refresh-note">30秒ごとに自動更新 / 最終更新: <span id="last-updated">-</span></div>

<script>
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return sign + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function loadDashboard() {
  try {
    const [summaryRes, historyRes] = await Promise.all([
      fetch("/api/summary").then((r) => r.json()),
      fetch("/api/history?limit=100").then((r) => r.json()),
    ]);

    // サマリーカード
    const pnl = summaryRes.account?.dailyPnl ?? 0;
    const pnlClass = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "";
    document.getElementById("summary-cards").innerHTML = \`
      <div class="card">
        <div class="label">当日損益</div>
        <div class="value \${pnlClass}">\${fmtMoney(pnl)}</div>
      </div>
      <div class="card">
        <div class="label">口座評価額</div>
        <div class="value">\${fmtMoney(summaryRes.currentEquity)}</div>
      </div>
      <div class="card">
        <div class="label">利用可能資金</div>
        <div class="value">\${fmtMoney(summaryRes.cashBalance)}</div>
      </div>
      <div class="card">
        <div class="label">本日の取引回数</div>
        <div class="value">\${summaryRes.todayTradeCount ?? 0}</div>
      </div>
    \`;

    document.getElementById("halted-banner").style.display = summaryRes.account?.halted ? "block" : "none";

    // ポジション
    const posBody = document.getElementById("positions-body");
    const positions = Object.entries(summaryRes.positions || {}).filter(([, v]) => v.position !== 0);
    posBody.innerHTML = positions
      .map(([symbol, v]) => \`<tr><td>\${symbol}</td><td class="\${v.position > 0 ? "qty-pos" : "qty-zero"}">\${v.position}</td></tr>\`)
      .join("");
    document.getElementById("positions-empty").style.display = positions.length ? "none" : "block";

    // 取引履歴
    const historyBody = document.getElementById("history-body");
    const trades = historyRes.trades || [];
    historyBody.innerHTML = trades
      .map(
        (t) => \`<tr>
          <td>\${fmtTime(t.time)}</td>
          <td>\${t.symbol}</td>
          <td><span class="badge \${t.action === "BUY" ? "buy" : "sell"}">\${t.action}</span></td>
          <td>\${t.quantity}</td>
          <td>\${t.price != null ? Number(t.price).toLocaleString() + " " + (t.currency || "") : "-"}</td>
          <td>\${t.reason || "-"}</td>
        </tr>\`
      )
      .join("");
    document.getElementById("history-empty").style.display = trades.length ? "none" : "block";

    document.getElementById("last-updated").textContent = new Date().toLocaleTimeString("ja-JP");
  } catch (err) {
    console.error("Dashboard load failed:", err);
  }
}

loadDashboard();
setInterval(loadDashboard, 30000);
</script>
</body>
</html>`;
