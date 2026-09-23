import type { Target } from "./types.js";

/** 同時にアクセスするホストの上限。1ホストあたりは常に直列なので、同じサイトへの同時アクセスは起きない */
export const MAX_CONCURRENT_HOSTS = 4;

/**
 * 同一ホストへの連続アクセスに最低間隔を設ける。
 * 短時間に同じサイトへ何度もアクセスすると bot として遮断されるため（Amazon で実測）、
 * 相手サーバーへの配慮もかねて間隔を空ける。ホストが異なれば待たない。
 */
const MIN_HOST_INTERVAL_MS = 5_000;

const lastAccessAt = new Map<string, number>();

/** 前回アクセスからの経過時間をもとに、次のアクセスまで待つべきミリ秒を返す */
export function pendingWaitMs(
  lastAt: number | undefined,
  now: number,
  intervalMs = MIN_HOST_INTERVAL_MS,
): number {
  if (lastAt === undefined) return 0;
  const remaining = intervalMs - (now - lastAt);
  return remaining > 0 ? remaining : 0;
}

/** URL のホストが空くまで待ち、実際に待った時間を返す。URL が不正なら待たない */
export async function awaitHostSlot(url: string): Promise<number> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 0;
  }
  const waitMs = pendingWaitMs(lastAccessAt.get(host), Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastAccessAt.set(host, Date.now());
  return waitMs;
}

/** テスト用: 記録をリセットする */
export function resetHostSlots(): void {
  lastAccessAt.clear();
}

/** ターゲットをホストごとにまとめる。各グループ内は設定ファイルの順序を保つ */
export function groupTargetsByHost(targets: Target[]): Target[][] {
  const groups = new Map<string, Target[]>();
  for (const target of targets) {
    let host: string;
    try {
      host = new URL(target.url).hostname;
    } catch {
      // URL として解釈できない場合は同一視せず、そのターゲット単独のグループにする
      host = target.url;
    }
    const group = groups.get(host);
    if (group) {
      group.push(target);
    } else {
      groups.set(host, [target]);
    }
  }
  return [...groups.values()];
}

/** タスクを最大 limit 本まで並行実行する。1本が失敗しても他は止めない（タスク側で例外を処理すること） */
export async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      await tasks[index]();
    }
  });
  await Promise.all(workers);
}
