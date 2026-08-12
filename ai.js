// Claude APIに現在の株価・保有状況を渡し、売買判断をさせる
//
// 重要: これは「戦略」ではありません。明確な検証済みロジックの代わりにLLMの判断に
// 発注可否を委ねる方式です。判断根拠が毎回変わりうる(再現性が低い)ため、
// 想定外の判断をすることがある前提で、呼び出し側で数量・損失上限の制約を必ず掛けてください。

const SYSTEM_PROMPT = `あなたは短期株式売買の意思決定を補助するアシスタントです。
与えられた銘柄の直近株価・保有状況・当日損益をもとに、次のアクションを判断してください。

必ず以下のJSON形式のみで回答してください。前置きや説明文は一切不要です。
{
  "action": "BUY" | "SELL" | "HOLD",
  "quantity": <整数、HOLDの場合は0>,
  "reason": "<判断理由を日本語で1〜2文>"
}

制約:
- 保有株数を超える売り注文は出さないこと
- 確信が持てない場合は必ず HOLD を選ぶこと`;

export async function decideTradeAction(env, { symbol, price, position, dailyPnl, cash }) {
  const userPrompt = `銘柄: ${symbol}
現在値: ${price}
保有株数: ${position}
当日損益: ${dailyPnl}
利用可能資金: ${cash}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("AI response contained no text block");

  let decision;
  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    decision = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse AI decision as JSON: ${textBlock.text}`);
  }

  if (!["BUY", "SELL", "HOLD"].includes(decision.action)) {
    throw new Error(`Unexpected action from AI: ${decision.action}`);
  }

  return decision;
}
