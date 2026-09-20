import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findNewItems, knownItemKeys } from "./items.js";
import { applyResult } from "./state.js";
import type { CheckResult, ItemRef, StateFile, Target } from "./types.js";

const T0 = "2026-09-20T00:00:00.000Z";
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const plus = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

const listTarget: Target = {
  name: "list",
  url: "https://example.com/list",
  triggerWhen: { type: "items_added", selector: "li", keyAttribute: "data-id" },
};
/** listTarget と同名で、ルール種別だけ真偽ルールに変えたもの（種別変更時の掃除を確認する用） */
const boolTarget: Target = {
  name: "list",
  url: "https://example.com/",
  triggerWhen: { type: "text_present", text: "x" },
};

function freshState(): StateFile {
  return { version: 1, targets: {} };
}

function result(partial: Partial<CheckResult> & Pick<CheckResult, "status">): CheckResult {
  return { targetName: "list", checkedAt: T0, elapsedMs: 1, ...partial };
}

/** checker と同じ手順で「前回 state から既知キーを求めて差分を出し、applyResult に渡す」までを再現する */
function observe(state: StateFile, keys: string[], checkedAt: string) {
  const items: ItemRef[] = keys.map((key) => ({ key }));
  const known = knownItemKeys(state.targets[listTarget.name], checkedAt);
  const newItems = findNewItems(items, known);
  return applyResult(
    state,
    listTarget,
    result({
      status: newItems.length > 0 ? "matched" : "unmatched",
      checkedAt,
      items,
      newItems,
    }),
  );
}

describe("applyResult: items_added", () => {
  it("初回は基準取得のみで通知せず、seenItems を保存する", () => {
    const state = freshState();
    const o = observe(state, ["a", "b"], T0);
    assert.equal(o.event, null);
    assert.equal(o.previousStatus, "unknown");
    assert.equal(state.targets.list.lastStatus, "unmatched");
    assert.deepEqual(state.targets.list.seenItems, { a: T0, b: T0 });
  });

  it("2回目以降、前回なかった項目があれば通知し、newItems に載せる", () => {
    const state = freshState();
    observe(state, ["a", "b"], T0);
    const o = observe(state, ["c", "a", "b"], plus(10 * MIN));
    assert.notEqual(o.event, null);
    assert.equal(o.event!.previousStatus, "unmatched");
    assert.deepEqual(o.event!.result.newItems, [{ key: "c" }]);
    assert.equal(state.targets.list.lastStatus, "matched");
    assert.equal(state.targets.list.lastNotifiedAt, plus(10 * MIN));
  });

  it("連続して新着があれば matched → matched でも毎回通知する", () => {
    const state = freshState();
    observe(state, ["a"], T0);
    observe(state, ["b", "a"], plus(10 * MIN));
    const o = observe(state, ["c", "b", "a"], plus(20 * MIN));
    assert.notEqual(o.event, null);
    assert.equal(o.event!.previousStatus, "matched");
    assert.deepEqual(o.event!.result.newItems, [{ key: "c" }]);
  });

  it("新着がなければ通知しない", () => {
    const state = freshState();
    observe(state, ["a", "b"], T0);
    const o = observe(state, ["b", "a"], plus(10 * MIN));
    assert.equal(o.event, null);
    assert.equal(state.targets.list.lastStatus, "unmatched");
  });

  it("保持期間内に一覧から消えて戻ってきた項目は再通知しない", () => {
    const state = freshState();
    observe(state, ["a", "b"], T0);
    observe(state, ["a"], plus(1 * DAY));
    const o = observe(state, ["a", "b"], plus(2 * DAY));
    assert.equal(o.event, null);
    assert.equal(state.targets.list.seenItems!.b, plus(2 * DAY));
  });

  it("保持期間を超えて消えていた項目が戻ってくると再通知する", () => {
    const state = freshState();
    observe(state, ["a", "b"], T0);
    observe(state, ["a"], plus(1 * DAY));
    observe(state, ["a"], plus(4 * DAY));
    observe(state, ["a"], plus(7 * DAY)); // b は T0 から 7 日ちょうど → まだ既知
    assert.equal(Object.hasOwn(state.targets.list.seenItems!, "b"), true);
    const o = observe(state, ["a", "b"], plus(7 * DAY + 1000)); // 7 日を超えた → 新着
    assert.notEqual(o.event, null);
    assert.deepEqual(o.event!.result.newItems, [{ key: "b" }]);
  });

  it("error のときは lastStatus も seenItems も変更しない", () => {
    const state = freshState();
    observe(state, ["a", "b"], T0);
    const o = applyResult(
      state,
      listTarget,
      result({ status: "error", checkedAt: plus(10 * MIN), error: "boom" }),
    );
    assert.equal(o.event, null);
    assert.equal(state.targets.list.lastStatus, "unmatched");
    assert.equal(state.targets.list.consecutiveFailures, 1);
    assert.deepEqual(state.targets.list.seenItems, { a: T0, b: T0 });
  });

  it("ルール種別を真偽ルールに変えると seenItems は掃除される", () => {
    const state = freshState();
    observe(state, ["a"], T0);
    applyResult(state, boolTarget, result({ status: "unmatched", checkedAt: plus(10 * MIN) }));
    assert.equal(state.targets.list.seenItems, undefined);
  });
});

describe("applyResult: 真偽ルール（既存挙動）", () => {
  it("初回 matched は1回通知し、matched が続いても再通知しない", () => {
    const state = freshState();
    const first = applyResult(state, boolTarget, result({ status: "matched" }));
    assert.notEqual(first.event, null);
    assert.equal(first.event!.previousStatus, "unknown");
    const second = applyResult(
      state,
      boolTarget,
      result({ status: "matched", checkedAt: plus(10 * MIN) }),
    );
    assert.equal(second.event, null);
  });

  it("unmatched → matched の遷移で通知する", () => {
    const state = freshState();
    applyResult(state, boolTarget, result({ status: "unmatched" }));
    const o = applyResult(state, boolTarget, result({ status: "matched", checkedAt: plus(10 * MIN) }));
    assert.notEqual(o.event, null);
    assert.equal(o.event!.previousStatus, "unmatched");
  });
});
