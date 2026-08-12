

# webull-trading-bot (v1: 動くものを作るフェーズ)

ウィブル証券OpenAPI + Claude API で米国株の自動売買を行うCloudflare Worker。

## できること / まだできないこと

- ✅ 1分間隔(Cron Trigger)で起動 → 株価取得 → AI判断 → 発注 の一連の流れ
- ✅ 日次損失上限に達したら新規発注を自動停止(サーキットブレーカー)
- ✅ 1回の注文数量に安全キャップ(`MAX_ORDER_QTY`)
- ⚠️ ウィブル証券の日本向けOpenAPIには「現在値取得」エンドポイントが今のところ存在しません。
  `src/webull.js` の `fetchQuoteExternal` は暫定的にYahoo Financeの遅延データを使っています。
  実運用に耐えるデータソースへの差し替えが必須です。
- ❌ ポジションサイジングのロジック、損切り/利確ライン、複数銘柄対応は未実装
- ❌ 発注失敗時の通知(Slack等)は未実装(TODOコメントのみ)

## セットアップ

### 1. Webull APIキーの取得
1. ウィブル証券の口座を開設
2. https://www.webull.co.jp/center/manage-app で「OpenAPI登録」からアプリを作成し、App Key / App Secretを発行
3. Account List API で `account_id` を取得(初回だけ手動で叩くか、`/run` エンドポイント経由で確認)

### 2. wrangler CLIのセットアップ
```bash
npm install -g wrangler
wrangler login
```

### 3. KV Namespaceの作成
```bash
wrangler kv namespace create TRADING_STATE
```
出力された `id` を `wrangler.toml` の `id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"` に設定してください。

### 4. シークレットの登録(Cloudflareダッシュボードから)

`wrangler secret put` の代わりに、ダッシュボードのUIから登録できます。

1. Cloudflareダッシュボード → **Workers & Pages** → 対象のWorker(`webull-trading-bot`、初回はまず一度 `wrangler deploy` して作成しておく) を選択
2. **Settings** タブ → **Variables and Secrets**
3. **Add** から以下を1つずつ登録(型は必ず **Secret** を選択。Textにすると平文で見えてしまいます)

| Variable name | 値の例 | 用途 |
|---|---|---|
| `WEBULL_APP_KEY` | ウィブル証券OpenAPI登録画面で発行したApp Key | API署名認証 |
| `WEBULL_APP_SECRET` | 同上のApp Secret | API署名認証 |
| `WEBULL_ACCOUNT_ID` | Account List API で取得した口座ID | 発注・残高照会 |
| `ANTHROPIC_API_KEY` | Anthropic ConsoleのAPIキー | AI判断呼び出し |
| `DAILY_LOSS_LIMIT` | 例: `50`(ドル、任意の数値文字列) | 日次損失上限。未設定時はコード内デフォルト(50ドル)が使われます |

4. 保存すると即座に反映されます(再デプロイ不要)。ローカル開発(`wrangler dev`)で使う場合は、リポジトリ直下に `.dev.vars` ファイルを作り `KEY=value` 形式で書いてください(**このファイルは絶対にgit管理に含めない**でください)。

### 5. デプロイ
```bash
wrangler deploy
```

### 6. 動作確認
デプロイ後のURLに対して:
- `GET /status` … 現在の取引状態(保有株数・当日損益・停止フラグ)を確認
- `GET /run` … 手動で1サイクル実行(本番公開する場合は認証を追加してください)

Cron Triggerは自動で1分毎に走ります。ログは `wrangler tail` で確認できます。

## 次にやるべきこと(優先順)

1. **信頼できる株価データソースへの差し替え**(最優先。ここが不安定だとAIの判断も不安定になる)
2. `/run` と `wrangler.toml` へのBasic認証等(誰でも叩ける状態は危険)
3. 発注失敗・API障害時の通知の仕組み(Slack Webhook等)
4. ポジションサイジング・損切りラインの明文化(現状は「AI任せ」なので、想定外の判断をした際の被害範囲を狭める仕組みが必要)
5. しばらくは `MAX_ORDER_QTY = 1` のまま、少額・少数株での動作確認を推奨
