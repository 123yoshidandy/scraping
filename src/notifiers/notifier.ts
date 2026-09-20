import type { Notifier } from "../types.js";
import { ConsoleNotifier } from "./console.js";
import { DiscordNotifier } from "./discord.js";
import { StepSummaryNotifier } from "./step-summary.js";

export type { Notifier, TriggerEvent } from "../types.js";

/**
 * 有効な通知先の一覧を返す。
 * Slack/LINE 等を追加する場合はここに実装を足す
 * （環境変数の有無で有効/無効を切り替える設計を推奨。DiscordNotifier / StepSummaryNotifier が例）。
 */
export function getNotifiers(): Notifier[] {
  return [new ConsoleNotifier(), new StepSummaryNotifier(), new DiscordNotifier()];
}
