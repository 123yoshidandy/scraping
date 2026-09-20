export type RuleType =
  | "selector_exists"
  | "selector_absent"
  | "text_present"
  | "text_absent"
  | "items_added";

export interface TriggerRule {
  type: RuleType;
  selector?: string;
  text?: string;
  /** items_added 用: 各項目要素を一意に識別する属性名（例: "data-id"）。items_added では必須 */
  keyAttribute?: string;
  /** items_added 用: 項目要素内で表示名を取る相対セレクタ。省略時は項目全体のテキスト */
  labelSelector?: string;
}

/** items_added ルールで観測した一覧の1項目 */
export interface ItemRef {
  /** keyAttribute の値。項目の同一性判定に使う */
  key: string;
  /** 通知に表示する名前（空白正規化・切り詰め済み） */
  label?: string;
  /** 項目内の最初のリンク（絶対URL） */
  url?: string;
}

export interface Target {
  /** 一意な識別子。state のキーになるため、リネームするとその対象の state はリセットされる */
  name: string;
  url: string;
  /** 通知文言に使う人間向け説明 */
  description?: string;
  /** この条件が成立したら通知する */
  triggerWhen: TriggerRule;
  /**
   * ページが正しく表示されていることのサニティチェック用セレクタ。
   * これが見つからない場合は判定不能（error）扱いとし、
   * bot 遮断ページや白紙ページを「条件成立」と誤検知することを防ぐ。
   */
  requireSelector?: string;
  /** default: true */
  enabled?: boolean;
  /** ナビゲーションのタイムアウト。default: 30000 */
  timeoutMs?: number;
  /** default: "domcontentloaded" */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /** ナビゲーション後の追加待機（JSレンダリング待ち）。default: 0 */
  extraWaitMs?: number;
  userAgent?: string;
  /** default: "ja-JP" */
  locale?: string;
  /** default: "Asia/Tokyo" */
  timezoneId?: string;
}

/** matched: 条件成立 / unmatched: 不成立 / error: 判定不能 */
export type CheckStatus = "matched" | "unmatched" | "error";

export interface CheckResult {
  targetName: string;
  status: CheckStatus;
  /** ISO 8601 */
  checkedAt: string;
  elapsedMs: number;
  httpStatus?: number;
  pageTitle?: string;
  /** status === "error" のときの理由 */
  error?: string;
  screenshotPath?: string;
  /** items_added のみ: 今回観測した全項目（ページ内の順序） */
  items?: ItemRef[];
  /** items_added のみ: 前回までに観測していなかった項目（通知対象）。初回（基準取得）は空配列 */
  newItems?: ItemRef[];
}

export interface TargetState {
  lastStatus: "matched" | "unmatched" | "unknown";
  lastCheckedAt: string;
  lastChangedAt: string;
  consecutiveFailures: number;
  lastNotifiedAt?: string;
  /** items_added のみ: 項目キー → 最後に観測した時刻 (ISO 8601)。未保存なら次回は基準取得になる */
  seenItems?: Record<string, string>;
}

export interface StateFile {
  version: 1;
  targets: Record<string, TargetState>;
}

export interface TriggerEvent {
  target: Target;
  result: CheckResult;
  /**
   * 通知直前の状態。真偽ルールでは unmatched | unknown のみだが、
   * items_added は matched のまま新着が出るたびに通知するため matched も含む
   */
  previousStatus: TargetState["lastStatus"];
}

export interface Notifier {
  readonly name: string;
  notifyTrigger(event: TriggerEvent): Promise<void>;
}
