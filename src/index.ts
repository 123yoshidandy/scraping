import { chromium } from "playwright";
import { checkTarget } from "./checker.js";
import { ConfigError, loadTargets } from "./config.js";
import { knownItemKeys } from "./items.js";
import { describeValue } from "./numbers.js";
import { getNotifiers } from "./notifiers/notifier.js";
import { writeRunReport, type ReportRow } from "./report.js";
import { applyResult, DEGRADED_THRESHOLD, loadState, saveState } from "./state.js";
import type { Target, TriggerEvent } from "./types.js";

const TARGETS_PATH = process.env.TARGETS_PATH ?? "targets.json";

async function main(): Promise<number> {
  let targets: Target[];
  try {
    targets = loadTargets(TARGETS_PATH);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  const enabled = targets.filter((t) => t.enabled !== false);
  if (enabled.length === 0) {
    console.error("チェック可能なターゲットが0件です（すべて無効化されているか、設定が空です）");
    return 1;
  }
  console.log(`${enabled.length}件のターゲットをチェックします (${TARGETS_PATH})`);

  const state = loadState();
  const events: TriggerEvent[] = [];
  const rows: ReportRow[] = [];

  const browser = await chromium.launch();
  try {
    for (const target of enabled) {
      // items_added 用に既知の項目キー集合を渡す（真偽ルールのターゲットは seenItems が無いので undefined になる）
      const result = await checkTarget(
        browser,
        target,
        knownItemKeys(state.targets[target.name], new Date().toISOString()),
      );
      const outcome = applyResult(state, target, result);
      if (outcome.event) {
        events.push(outcome.event);
      }
      if (outcome.becameDegraded) {
        // GitHub Actions のワークフローアノテーション（閾値を跨いだ実行時のみ出す）
        console.log(
          `::warning title=${target.name}::${DEGRADED_THRESHOLD}回連続でチェックに失敗しています: ${result.error ?? ""}`,
        );
      }
      // number_at_most の観測値。不成立の実行でも根拠を残すため、常にログとレポートに出す
      const valueNote = describeValue(target, result);
      rows.push({
        name: target.name,
        status: result.status,
        previous: outcome.previousStatus,
        elapsedMs: result.elapsedMs,
        consecutiveFailures: state.targets[target.name]?.consecutiveFailures ?? 0,
        note: outcome.event
          ? result.newItems
            ? `🔔 TRIGGERED (${result.newItems.length}件の新着)`
            : `🔔 TRIGGERED${valueNote ? ` (${valueNote})` : ""}`
          : (result.error ?? valueNote ?? ""),
      });
      const itemsNote = result.items
        ? ` 全${result.items.length}件 / 新着${result.newItems?.length ?? 0}件`
        : "";
      console.log(
        `[${result.status}] ${target.name} (${result.elapsedMs}ms)${itemsNote}${valueNote ? ` ${valueNote}` : ""}${result.error ? ` - ${result.error}` : ""}`,
      );
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // 通知は notifier ごとに独立して実行し、1つの失敗が他を巻き込まないようにする
  const notifiers = getNotifiers();
  for (const event of events) {
    for (const notifier of notifiers) {
      try {
        await notifier.notifyTrigger(event);
      } catch (e) {
        console.error(`[notifier:${notifier.name}] 通知に失敗しました: ${String(e)}`);
      }
    }
  }

  // prune は無効化(enabled: false)ではなく config からの削除のみを対象にするため、全ターゲットを渡す
  saveState(state, targets);
  writeRunReport(rows, events);

  if (process.env.FAIL_ON_TRIGGER === "1" && events.length > 0) {
    console.log(
      "FAIL_ON_TRIGGER=1 のため、条件成立の検知によりジョブを失敗させます（GitHub の失敗通知メールを暫定通知として利用）",
    );
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error("未処理のエラーが発生しました:", e);
    process.exitCode = 1;
  });
