import { appendFileSync } from "node:fs";
import { DEGRADED_THRESHOLD } from "./state.js";
import type { TriggerEvent } from "./types.js";

export interface ReportRow {
  name: string;
  status: string;
  previous: string;
  elapsedMs: number;
  consecutiveFailures: number;
  note: string;
}

/** 全ターゲットの実行結果をコンソールと GITHUB_STEP_SUMMARY（設定時のみ）に出力する */
export function writeRunReport(rows: ReportRow[], events: TriggerEvent[]): void {
  console.log("\n===== 実行レポート =====");
  for (const r of rows) {
    const note = r.note ? ` - ${r.note}` : "";
    console.log(
      `${statusIcon(r.status)} ${r.name}: ${r.status} (前回: ${r.previous}, ${r.elapsedMs}ms, 連続失敗: ${r.consecutiveFailures})${note}`,
    );
  }
  console.log(`条件成立の検知: ${events.length}件\n`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const lines = [
    "## 📋 実行レポート",
    "",
    "| Target | Status | Previous | Elapsed | Failures | Note |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${escapeMd(r.name)} | ${statusIcon(r.status)} ${r.status} | ${r.previous} | ${r.elapsedMs}ms | ${r.consecutiveFailures} | ${escapeMd(r.note)} |`,
    ),
    "",
  ];
  const degraded = rows.filter((r) => r.consecutiveFailures >= DEGRADED_THRESHOLD);
  if (degraded.length > 0) {
    lines.push(
      "### ⚠️ Degraded targets",
      "",
      ...degraded.map(
        (r) => `- ${escapeMd(r.name)}: ${r.consecutiveFailures}回連続でチェック失敗 (${escapeMd(r.note)})`,
      ),
      "",
    );
  }
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

function statusIcon(status: string): string {
  switch (status) {
    case "matched":
      return "🟢";
    case "unmatched":
      return "⚪";
    default:
      return "🔴";
  }
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
