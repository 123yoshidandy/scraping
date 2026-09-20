import type { ItemRef, TargetState } from "./types.js";

/**
 * seenItems に項目を保持する期間。
 * この期間内に一覧から消えて戻ってきた項目は「新着」とみなさない（一時的な取りこぼし・並び替えの吸収）。
 * 逆に、この期間を超えて消えていた項目が戻ってくると再度通知される。
 */
export const SEEN_ITEMS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 通知に列挙する新着項目の最大数（超過分は「…他N件」にまとめる） */
export const MAX_LISTED_ITEMS = 30;
const MAX_LABEL_LENGTH = 80;

/** ブラウザ側で抽出した生の項目情報（正規化前） */
export interface RawItem {
  key: string | null;
  label: string | null;
  url: string | null;
}

/**
 * 生の項目情報を整形する。
 * - key を trim し、空のものは除外
 * - key が重複する項目は先勝ちで1つにする
 * - label は空白を正規化し MAX_LABEL_LENGTH 文字で切り詰める
 * ページ内の順序は保持する。
 */
export function normalizeItems(raw: RawItem[]): ItemRef[] {
  const seen = new Set<string>();
  const items: ItemRef[] = [];
  for (const r of raw) {
    const key = r.key?.trim() ?? "";
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const item: ItemRef = { key };
    const label = normalizeLabel(r.label);
    if (label !== undefined) item.label = label;
    const url = r.url?.trim();
    if (url) item.url = url;
    items.push(item);
  }
  return items;
}

/**
 * 前回 state から「既知の項目キー集合」を作る。
 * seenItems が未保存（新規ターゲット / state リセット / リネーム後）なら undefined を返し、
 * 呼び出し側はそれを「基準取得（通知しない）」として扱う。
 * 保持期間を過ぎたエントリは既知とみなさない（mergeSeenItems の prune と一致させる）。
 */
export function knownItemKeys(
  prev: Pick<TargetState, "seenItems"> | undefined,
  now: string,
): ReadonlySet<string> | undefined {
  if (!prev?.seenItems) return undefined;
  return new Set(pruneSeenItems(prev.seenItems, now).keys());
}

/** known が undefined（基準取得）なら常に空。それ以外は既知でない項目をページ内の順序で返す */
export function findNewItems(
  items: ItemRef[],
  known: ReadonlySet<string> | undefined,
): ItemRef[] {
  if (known === undefined) return [];
  return items.filter((i) => !known.has(i.key));
}

/**
 * 保持期間外のエントリを落とし、今回観測した項目を now で upsert する。
 * items が空でも既存エントリは（保持期間内なら）残る。
 */
export function mergeSeenItems(
  prevSeen: Record<string, string> | undefined,
  items: ItemRef[],
  now: string,
): Record<string, string> {
  const next = pruneSeenItems(prevSeen ?? {}, now);
  for (const i of items) {
    next.set(i.key, now);
  }
  // Object.fromEntries は "__proto__" のようなキーも自前プロパティとして定義する
  return Object.fromEntries(next);
}

/** 先頭 max 件を render で整形し、残りは「…他N件」1行にまとめる */
export function listItemLines(
  items: ItemRef[],
  render: (item: ItemRef) => string,
  max: number = MAX_LISTED_ITEMS,
): string[] {
  const lines = items.slice(0, max).map(render);
  if (items.length > max) {
    lines.push(`…他${items.length - max}件`);
  }
  return lines;
}

/**
 * 保持期間内のエントリだけを Map で返す。
 * `key in obj` は "constructor" 等のプロトタイプ由来の名前で誤判定するため、
 * 判定は必ず Object.entries 経由の Map / Set で行う。
 */
function pruneSeenItems(seen: Record<string, string>, now: string): Map<string, string> {
  const nowMs = Date.parse(now);
  const kept = new Map<string, string>();
  for (const [key, lastSeenAt] of Object.entries(seen)) {
    const seenMs = Date.parse(lastSeenAt);
    // 時刻が不正なエントリは保持しない（次回観測されれば再登録される）
    if (Number.isNaN(seenMs)) continue;
    if (!Number.isNaN(nowMs) && nowMs - seenMs > SEEN_ITEMS_RETENTION_MS) continue;
    kept.set(key, lastSeenAt);
  }
  return kept;
}

function normalizeLabel(label: string | null): string | undefined {
  if (label === null) return undefined;
  const s = label.replace(/\s+/g, " ").trim();
  if (s === "") return undefined;
  return s.length > MAX_LABEL_LENGTH ? `${s.slice(0, MAX_LABEL_LENGTH)}…` : s;
}

/** Markdown のリンクテキストとして安全なように角括弧をエスケープする */
export function escapeMdLabel(s: string): string {
  return s.replace(/[[\]]/g, "\\$&");
}
