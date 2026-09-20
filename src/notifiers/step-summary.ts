import { appendFileSync } from "node:fs";
import { escapeMdLabel, listItemLines } from "../items.js";
import type { Notifier, TriggerEvent } from "../types.js";

/**
 * GitHub Actions のジョブサマリーに条件成立バナーを書き込む。
 * GITHUB_STEP_SUMMARY が未設定（ローカル実行など）の場合は何もしない。
 */
export class StepSummaryNotifier implements Notifier {
  readonly name = "step-summary";

  async notifyTrigger(event: TriggerEvent): Promise<void> {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;

    const { target, result, previousStatus } = event;
    // items_added は新着項目を Markdown リストで列挙し、真偽ルールは状態遷移を表示する
    const detail = result.newItems
      ? [
          `- 新着: ${result.newItems.length}件`,
          ...listItemLines(result.newItems, (i) => {
            const label = escapeMdLabel(i.label ?? i.key);
            return i.url ? `[${label}](${i.url}) \`${i.key}\`` : `${label} \`${i.key}\``;
          }).map((line) => `  - ${line}`),
        ]
      : [`- 状態: \`${previousStatus}\` → \`matched\``];
    const lines = [
      `# 🔔 条件成立: ${target.name}`,
      "",
      ...(target.description ? [target.description, ""] : []),
      `- URL: ${target.url}`,
      ...detail,
      `- 検知時刻: ${result.checkedAt}`,
      ...(result.screenshotPath
        ? [`- スクリーンショット: \`${result.screenshotPath}\`（Artifacts からダウンロード可能）`]
        : []),
      "",
    ];
    appendFileSync(summaryPath, `${lines.join("\n")}\n`);
  }
}
