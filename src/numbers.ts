import type { CheckResult, Target, TriggerRule } from "./types.js";

/** number_at_most の min 既定値。0円やポイント表示を「成立」と誤検出しないための下限 */
export const DEFAULT_MIN = 1;

/**
 * テキストから最初に現れる数値を取り出す。
 * 全角の数字・カンマ・ピリオドは半角に正規化し、桁区切りのカンマは除去する。
 * 例: "￥5,940" / "5,940円（税込）" / "５，９４０円" → 5940
 * 数値が見つからない場合は undefined。
 */
export function extractNumber(text: string): number | undefined {
  const normalized = text.replace(/[０-９，．]/g, (c) =>
    c === "，" ? "," : c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
  const m = /\d[\d,]*(?:\.\d+)?/.exec(normalized);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** 3桁区切りの日本語ロケール表記にする */
export function formatNumber(n: number): string {
  return n.toLocaleString("ja-JP");
}

/** ルール（all_of の子も含む）から最初の number_at_most を探す。通知に上限を表示するために使う */
export function findNumberRule(rule: TriggerRule): TriggerRule | undefined {
  if (rule.type === "number_at_most") return rule;
  for (const child of rule.rules ?? []) {
    const found = findNumberRule(child);
    if (found) return found;
  }
  return undefined;
}

/** 「観測値: 7,216（上限: 7,200）」。観測値が無ければ undefined */
export function describeValue(target: Target, result: CheckResult): string | undefined {
  if (result.value === undefined) return undefined;
  const max = findNumberRule(target.triggerWhen)?.max;
  const limit = max === undefined ? "" : `（上限: ${formatNumber(max)}）`;
  return `観測値: ${formatNumber(result.value)}${limit}`;
}
