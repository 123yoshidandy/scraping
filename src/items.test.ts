import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findNewItems,
  knownItemKeys,
  listItemLines,
  mergeSeenItems,
  normalizeItems,
  SEEN_ITEMS_RETENTION_MS,
} from "./items.js";

const T0 = "2026-09-20T00:00:00.000Z";
const plus = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

describe("normalizeItems", () => {
  it("空キーを除外し、重複キーは先勝ちにする", () => {
    const items = normalizeItems([
      { key: " a ", label: "A1", url: "https://example.com/a" },
      { key: "", label: "none", url: null },
      { key: null, label: "none", url: null },
      { key: "a", label: "A2", url: null },
      { key: "b", label: null, url: null },
    ]);
    assert.deepEqual(items, [{ key: "a", label: "A1", url: "https://example.com/a" }, { key: "b" }]);
  });

  it("ラベルの空白を正規化し、80文字で切り詰める", () => {
    const [a, b] = normalizeItems([
      { key: "a", label: "  foo \n\t bar  ", url: null },
      { key: "b", label: "x".repeat(100), url: null },
    ]);
    assert.equal(a.label, "foo bar");
    assert.equal(b.label, `${"x".repeat(80)}…`);
  });

  it("__proto__ や constructor もキーとして扱える", () => {
    const items = normalizeItems([
      { key: "__proto__", label: null, url: null },
      { key: "constructor", label: null, url: null },
    ]);
    assert.deepEqual(
      items.map((i) => i.key),
      ["__proto__", "constructor"],
    );
  });
});

describe("knownItemKeys", () => {
  it("seenItems が無ければ undefined（基準取得）", () => {
    assert.equal(knownItemKeys(undefined, T0), undefined);
    assert.equal(knownItemKeys({}, T0), undefined);
  });

  it("保持期間を過ぎたエントリは既知に含めない（ちょうど保持期間ぶん前は含める）", () => {
    const known = knownItemKeys(
      {
        seenItems: {
          fresh: T0,
          stale: plus(-SEEN_ITEMS_RETENTION_MS - 1),
          edge: plus(-SEEN_ITEMS_RETENTION_MS),
        },
      },
      T0,
    );
    assert.deepEqual([...known!].sort(), ["edge", "fresh"]);
  });

  it("constructor という名前のキーを既知として判定でき、プロトタイプ由来の名前を誤判定しない", () => {
    const known = knownItemKeys({ seenItems: { constructor: T0 } }, T0);
    assert.equal(known!.has("constructor"), true);
    assert.equal(known!.has("toString"), false);
  });
});

describe("findNewItems", () => {
  it("基準取得（known が undefined）では常に空", () => {
    assert.deepEqual(findNewItems([{ key: "a" }], undefined), []);
  });

  it("既知でない項目をページ内の順序で返す", () => {
    const items = [{ key: "c" }, { key: "a" }, { key: "d" }, { key: "b" }];
    assert.deepEqual(findNewItems(items, new Set(["a", "b"])), [{ key: "c" }, { key: "d" }]);
  });
});

describe("mergeSeenItems", () => {
  it("保持期間外を落とした上で、今回の項目を now で upsert する", () => {
    const prev = {
      keep: plus(-1000),
      stale: plus(-SEEN_ITEMS_RETENTION_MS - 1),
      refresh: plus(-5000),
    };
    const next = mergeSeenItems(prev, [{ key: "refresh" }, { key: "new" }], T0);
    assert.deepEqual(next, { keep: plus(-1000), refresh: T0, new: T0 });
  });

  it("items が空でも保持期間内のエントリは残る", () => {
    assert.deepEqual(mergeSeenItems({ a: T0 }, [], T0), { a: T0 });
  });

  it("時刻が不正なエントリは捨てる", () => {
    assert.deepEqual(mergeSeenItems({ bad: "not-a-date", ok: T0 }, [], T0), { ok: T0 });
  });

  it("__proto__ をキーとして保存でき、JSON 往復後も既知として判定できる", () => {
    const next = mergeSeenItems(undefined, [{ key: "__proto__" }], T0);
    assert.equal(Object.hasOwn(next, "__proto__"), true);
    const roundTrip = JSON.parse(JSON.stringify(next)) as Record<string, string>;
    assert.deepEqual(Object.keys(roundTrip), ["__proto__"]);
    assert.equal(knownItemKeys({ seenItems: roundTrip }, T0)!.has("__proto__"), true);
  });
});

describe("listItemLines", () => {
  it("max 件までを整形し、超過分は「…他N件」にまとめる", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ key: String(i) }));
    assert.deepEqual(
      listItemLines(items, (i) => i.key, 3),
      ["0", "1", "2", "…他2件"],
    );
    assert.deepEqual(
      listItemLines(items, (i) => i.key, 5),
      ["0", "1", "2", "3", "4"],
    );
  });
});
