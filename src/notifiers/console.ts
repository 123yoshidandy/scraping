import { listItemLines } from "../items.js";
import type { Notifier, TriggerEvent } from "../types.js";

export class ConsoleNotifier implements Notifier {
  readonly name = "console";

  async notifyTrigger(event: TriggerEvent): Promise<void> {
    const { target, result, previousStatus } = event;
    // items_added は新着項目を列挙し、真偽ルールは状態遷移を表示する
    const detail = result.newItems
      ? [
          `新着: ${result.newItems.length}件`,
          ...listItemLines(
            result.newItems,
            (i) => `- ${i.label ?? i.key} (${i.key})${i.url ? ` ${i.url}` : ""}`,
          ),
        ].map((line) => `🔔 ${line}`)
      : [`🔔 状態: ${previousStatus} → matched`];
    const lines = [
      "",
      "🔔 ============================================",
      `🔔 条件成立を検知: ${target.name}`,
      ...(target.description ? [`🔔 ${target.description}`] : []),
      `🔔 URL: ${target.url}`,
      ...detail,
      `🔔 検知時刻: ${result.checkedAt}`,
      ...(result.screenshotPath ? [`🔔 スクリーンショット: ${result.screenshotPath}`] : []),
      "🔔 ============================================",
      "",
    ];
    console.log(lines.join("\n"));
  }
}
