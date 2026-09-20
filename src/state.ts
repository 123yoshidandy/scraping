import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mergeSeenItems } from "./items.js";
import type { StateFile, TargetState, Target, CheckResult, TriggerEvent } from "./types.js";

const STATE_DIR = ".state";
const STATE_PATH = path.join(STATE_DIR, "state.json");

/** この回数連続で error になったら Degraded として警告する */
export const DEGRADED_THRESHOLD = 3;

export function loadState(): StateFile {
  if (!existsSync(STATE_PATH)) {
    return freshState();
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as StateFile).version !== 1 ||
      typeof (parsed as StateFile).targets !== "object" ||
      (parsed as StateFile).targets === null
    ) {
      console.warn(`[state] ${STATE_PATH} の形式が不明なため初期化します`);
      return freshState();
    }
    return parsed as StateFile;
  } catch (e) {
    console.warn(`[state] ${STATE_PATH} を読み込めないため初期化します (${String(e)})`);
    return freshState();
  }
}

/** config に存在しないターゲットの state を削除した上で保存する */
export function saveState(state: StateFile, targets: Target[]): void {
  const names = new Set(targets.map((t) => t.name));
  for (const key of Object.keys(state.targets)) {
    if (!names.has(key)) {
      delete state.targets[key];
    }
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export interface ApplyOutcome {
  /**
   * 通知すべき条件成立イベント。
   * 真偽ルールは unmatched/unknown → matched の遷移時のみ、items_added は新着（newItems）があるたび
   */
  event: TriggerEvent | null;
  /** consecutiveFailures がこの実行でちょうど閾値に達した（警告アノテーション用） */
  becameDegraded: boolean;
  previousStatus: TargetState["lastStatus"];
}

export function applyResult(state: StateFile, target: Target, result: CheckResult): ApplyOutcome {
  const prev: TargetState = state.targets[target.name] ?? {
    lastStatus: "unknown",
    lastCheckedAt: result.checkedAt,
    lastChangedAt: result.checkedAt,
    consecutiveFailures: 0,
  };
  const previousStatus = prev.lastStatus;
  const next: TargetState = { ...prev, lastCheckedAt: result.checkedAt };
  let event: TriggerEvent | null = null;
  let becameDegraded = false;

  if (result.status === "error") {
    // 判定不能: lastStatus と seenItems は変更せず最後の既知状態を保持する
    next.consecutiveFailures = prev.consecutiveFailures + 1;
    becameDegraded = next.consecutiveFailures === DEGRADED_THRESHOLD;
  } else {
    next.consecutiveFailures = 0;
    if (result.status !== prev.lastStatus) {
      next.lastChangedAt = result.checkedAt;
    }
    // 差分ルール（items_added）は matched のたびに通知する。真偽ルールは遷移時のみ
    const isDeltaRule = result.newItems !== undefined;
    if (result.status === "matched" && (isDeltaRule || prev.lastStatus !== "matched")) {
      event = { target, result, previousStatus: prev.lastStatus };
      next.lastNotifiedAt = result.checkedAt;
    }
    if (result.items !== undefined) {
      next.seenItems = mergeSeenItems(prev.seenItems, result.items, result.checkedAt);
    } else {
      // ルール種別を items_added から別のものに変えた場合の残骸を掃除する
      delete next.seenItems;
    }
    next.lastStatus = result.status;
  }

  state.targets[target.name] = next;
  return { event, becameDegraded, previousStatus };
}

function freshState(): StateFile {
  return { version: 1, targets: {} };
}
