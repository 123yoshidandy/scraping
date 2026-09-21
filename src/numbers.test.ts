import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeValue, extractNumber, findNumberRule, formatNumber } from "./numbers.js";
import type { CheckResult, Target, TriggerRule } from "./types.js";

describe("extractNumber", () => {
  it("通貨記号・桁区切り・単位つきの表記から数値を取り出す", () => {
    assert.equal(extractNumber("￥5,940"), 5940);
    assert.equal(extractNumber("5,940円（税込）"), 5940);
    assert.equal(extractNumber("¥7,216 税込"), 7216);
    assert.equal(extractNumber("  6,006  "), 6006);
  });

  it("全角の数字・カンマ・ピリオドを半角として扱う", () => {
    assert.equal(extractNumber("５，９４０円"), 5940);
    assert.equal(extractNumber("１２３４．５"), 1234.5);
  });

  it("小数を保持する", () => {
    assert.equal(extractNumber("1,234.5"), 1234.5);
  });

  it("数値が無ければ undefined", () => {
    assert.equal(extractNumber("在庫なし"), undefined);
    assert.equal(extractNumber(""), undefined);
  });

  it("複数の数値があれば最初のものを返す（セレクタは価格要素に絞る必要がある）", () => {
    assert.equal(extractNumber("残り9点 ￥7,216"), 9);
  });
});

describe("formatNumber", () => {
  it("3桁区切りにする", () => {
    assert.equal(formatNumber(7216), "7,216");
    assert.equal(formatNumber(880), "880");
  });
});

const numberRule: TriggerRule = { type: "number_at_most", selector: ".price", max: 7200 };

describe("findNumberRule", () => {
  it("number_at_most 自身を返す", () => {
    assert.equal(findNumberRule(numberRule), numberRule);
  });

  it("all_of の子から探す", () => {
    const rule: TriggerRule = {
      type: "all_of",
      rules: [{ type: "selector_exists", selector: "#cart" }, numberRule],
    };
    assert.equal(findNumberRule(rule), numberRule);
  });

  it("見つからなければ undefined", () => {
    assert.equal(findNumberRule({ type: "text_present", text: "x" }), undefined);
    assert.equal(
      findNumberRule({ type: "all_of", rules: [{ type: "selector_exists", selector: "#c" }] }),
      undefined,
    );
  });
});

describe("describeValue", () => {
  const target = (triggerWhen: TriggerRule): Target => ({
    name: "t",
    url: "https://example.com/",
    triggerWhen,
  });
  const result = (value?: number): CheckResult => ({
    targetName: "t",
    status: "matched",
    checkedAt: "2026-09-22T00:00:00.000Z",
    elapsedMs: 1,
    value,
  });

  it("観測値と上限を表示する", () => {
    assert.equal(describeValue(target(numberRule), result(7216)), "観測値: 7,216（上限: 7,200）");
  });

  it("上限が特定できない場合は観測値のみ", () => {
    assert.equal(
      describeValue(target({ type: "selector_exists", selector: "#c" }), result(500)),
      "観測値: 500",
    );
  });

  it("観測値が無ければ undefined", () => {
    assert.equal(describeValue(target(numberRule), result(undefined)), undefined);
  });
});
