import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ItemRef, Target, TriggerEvent } from "../types.js";
import { buildDiscordPayload, DiscordNotifier } from "./discord.js";

const T0 = "2026-09-21T00:00:00.000Z";
const HOOK = "https://discord.test/hook";

const listTarget: Target = {
  name: "list",
  description: "一覧の新着",
  url: "https://example.com/list",
  triggerWhen: { type: "items_added", selector: "li", keyAttribute: "data-id" },
};

function itemsEvent(newItems: ItemRef[]): TriggerEvent {
  return {
    target: listTarget,
    result: {
      targetName: "list",
      status: "matched",
      checkedAt: T0,
      elapsedMs: 1,
      items: newItems,
      newItems,
    },
    previousStatus: "unmatched",
  };
}

const boolEvent: TriggerEvent = {
  target: { name: "bool", url: "https://example.com/", triggerWhen: { type: "text_present", text: "x" } },
  result: { targetName: "bool", status: "matched", checkedAt: T0, elapsedMs: 1 },
  previousStatus: "unmatched",
};

function makeItems(n: number, labelLength = 10): ItemRef[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    label: "x".repeat(labelLength),
    url: `https://example.com/items/${i}`,
  }));
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch call");
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("buildDiscordPayload", () => {
  it("新着があれば件数を content に、項目をリンク付きで description に載せる", () => {
    const p = buildDiscordPayload(
      itemsEvent([
        { key: "A", label: "Item [A]", url: "https://example.com/a" },
        { key: "B", label: "Item B" },
        { key: "C" },
      ]),
    );
    assert.equal(p.content, "🔔 list: 新着3件");
    assert.equal(p.embeds[0].title, "一覧の新着");
    assert.equal(p.embeds[0].url, "https://example.com/list");
    assert.equal(
      p.embeds[0].description,
      ["- [Item \\[A\\]](https://example.com/a) `A`", "- Item B `B`", "- C `C`"].join("\n"),
    );
    assert.equal(p.embeds[0].timestamp, T0);
    assert.equal(p.username, "page-watcher");
    assert.deepEqual(p.allowed_mentions, { parse: [] });
  });

  it("新着は最大20件まで列挙し、残りは件数にまとめる", () => {
    const p = buildDiscordPayload(itemsEvent(makeItems(25)));
    const lines = p.embeds[0].description.split("\n");
    assert.equal(lines.length, 21);
    assert.equal(lines[20], "…他5件");
  });

  it("長いラベルでも description は Discord の上限 4096 文字以内に収める", () => {
    const p = buildDiscordPayload(itemsEvent(makeItems(20, 300)));
    assert.ok(p.embeds[0].description.length <= 4096);
    assert.ok(p.embeds[0].description.endsWith("…"));
  });

  it("真偽ルールのイベントは状態遷移を載せ、description が無ければ name をタイトルにする", () => {
    const p = buildDiscordPayload(boolEvent);
    assert.equal(p.content, "🔔 条件成立: bool");
    assert.equal(p.embeds[0].title, "bool");
    assert.equal(p.embeds[0].description, "状態: unmatched → matched");
  });
});

describe("DiscordNotifier", () => {
  it("Webhook URL が未設定なら何もしない", async () => {
    const saved = process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_WEBHOOK_URL;
    try {
      const { fetchImpl, calls } = mockFetch([]);
      await new DiscordNotifier({ fetchImpl }).notifyTrigger(boolEvent);
      assert.equal(calls.length, 0);
    } finally {
      if (saved !== undefined) process.env.DISCORD_WEBHOOK_URL = saved;
    }
  });

  it("ペイロードを JSON で POST し、204 なら正常終了する", async () => {
    const { fetchImpl, calls } = mockFetch([new Response(null, { status: 204 })]);
    const event = itemsEvent(makeItems(2));
    await new DiscordNotifier({ webhookUrl: HOOK, fetchImpl }).notifyTrigger(event);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, HOOK);
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(calls[0].init?.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), buildDiscordPayload(event));
  });

  it("429 なら retry_after 後に1回だけ再送する", async () => {
    const { fetchImpl, calls } = mockFetch([
      new Response(JSON.stringify({ retry_after: 0.01 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(null, { status: 204 }),
    ]);
    await new DiscordNotifier({ webhookUrl: HOOK, fetchImpl }).notifyTrigger(boolEvent);
    assert.equal(calls.length, 2);
  });

  it("2xx 以外なら HTTP ステータスを含むエラーを投げる", async () => {
    const { fetchImpl } = mockFetch([new Response("nope", { status: 404 })]);
    await assert.rejects(
      new DiscordNotifier({ webhookUrl: HOOK, fetchImpl }).notifyTrigger(boolEvent),
      /Discord webhook HTTP 404/,
    );
  });
});
