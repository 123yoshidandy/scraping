import { escapeMdLabel, listItemLines } from "../items.js";
import { describeValue } from "../numbers.js";
import type { Notifier, TriggerEvent } from "../types.js";

const ENV_WEBHOOK_URL = "DISCORD_WEBHOOK_URL";
const USERNAME = "page-watcher";
/** Discord の上限は content 2000 / embed title 256 / embed description 4096。余裕を持って切り詰める */
const CONTENT_MAX = 1900;
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4000;
/** embed に列挙する新着項目の最大数（残りは「…他N件」） */
const MAX_LISTED_ITEMS = 20;
/** 429 の retry_after を待つ上限 */
const RETRY_AFTER_CAP_MS = 5_000;

export interface DiscordNotifierOptions {
  /** 省略時は notifyTrigger 実行時に process.env.DISCORD_WEBHOOK_URL を読む */
  webhookUrl?: string;
  /** テスト用の差し替え口。省略時は globalThis.fetch */
  fetchImpl?: typeof fetch;
}

export interface DiscordPayload {
  /** 1行目。スマホのプッシュ通知に表示される */
  content: string;
  embeds: [{ title: string; url: string; description: string; timestamp: string }];
  username: string;
  /** 商品名などに @everyone 等が混ざっていてもメンション通知が飛ばないようにする */
  allowed_mentions: { parse: [] };
}

/**
 * Discord の Incoming Webhook に条件成立を投稿する。
 * DISCORD_WEBHOOK_URL が未設定（ローカル実行など）の場合は何もしない。
 */
export class DiscordNotifier implements Notifier {
  readonly name = "discord";
  private readonly options: DiscordNotifierOptions;

  constructor(options: DiscordNotifierOptions = {}) {
    this.options = options;
  }

  async notifyTrigger(event: TriggerEvent): Promise<void> {
    const webhookUrl = this.options.webhookUrl ?? process.env[ENV_WEBHOOK_URL];
    if (!webhookUrl) return;
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const body = JSON.stringify(buildDiscordPayload(event));

    let response = await post(fetchImpl, webhookUrl, body);
    if (response.status === 429) {
      // レート制限: retry_after（秒）だけ待って1回だけ再送する
      const waitMs = Math.min(await readRetryAfterMs(response), RETRY_AFTER_CAP_MS);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      response = await post(fetchImpl, webhookUrl, body);
    }
    if (!response.ok) {
      // 呼び出し元（index.ts）が notifier ごとに捕捉してログに出す
      throw new Error(`Discord webhook HTTP ${response.status}`);
    }
  }
}

/** TriggerEvent から Discord Webhook のペイロードを組み立てる（純粋関数） */
export function buildDiscordPayload(event: TriggerEvent): DiscordPayload {
  const { target, result, previousStatus } = event;
  const newItems = result.newItems;
  const content = newItems
    ? `🔔 ${target.name}: 新着${newItems.length}件`
    : `🔔 条件成立: ${target.name}`;
  const description = newItems
    ? listItemLines(
        newItems,
        (i) => {
          const label = escapeMdLabel(i.label ?? i.key);
          return i.url ? `- [${label}](${i.url}) \`${i.key}\`` : `- ${label} \`${i.key}\``;
        },
        MAX_LISTED_ITEMS,
      ).join("\n")
    : `状態: ${previousStatus} → matched`;
  const valueLine = describeValue(target, result);
  const body = valueLine ? `${description}\n${valueLine}` : description;
  return {
    content: truncate(content, CONTENT_MAX),
    embeds: [
      {
        title: truncate(target.description ?? target.name, TITLE_MAX),
        url: target.url,
        description: truncate(body, DESCRIPTION_MAX),
        timestamp: result.checkedAt,
      },
    ],
    username: USERNAME,
    allowed_mentions: { parse: [] },
  };
}

function post(fetchImpl: typeof fetch, url: string, body: string): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function readRetryAfterMs(response: Response): Promise<number> {
  try {
    const json = (await response.json()) as { retry_after?: unknown };
    return typeof json.retry_after === "number" ? json.retry_after * 1000 : 1000;
  } catch {
    return 1000;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
