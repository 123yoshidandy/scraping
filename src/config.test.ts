import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ConfigError, loadTargets } from "./config.js";

const dir = mkdtempSync(path.join(tmpdir(), "page-watcher-config-"));
let seq = 0;

/** targets.json を一時ファイルに書いて読み込ませる */
function load(targets: unknown): ReturnType<typeof loadTargets> {
  const file = path.join(dir, `targets-${seq++}.json`);
  writeFileSync(file, JSON.stringify(targets));
  return loadTargets(file);
}

function loadError(targets: unknown): string {
  try {
    load(targets);
  } catch (e) {
    assert.ok(e instanceof ConfigError, `ConfigError ではありません: ${String(e)}`);
    return e.message;
  }
  throw new Error("エラーになるはずが成功しました");
}

const base = { name: "t", url: "https://example.com/" };

describe("loadTargets: all_of", () => {
  it("子ルールがすべて妥当なら読み込める", () => {
    const targets = load([
      {
        ...base,
        triggerWhen: {
          type: "all_of",
          rules: [
            { type: "number_at_most", selector: ".price", max: 7200 },
            { type: "selector_exists", selector: "#add-to-cart-button" },
            { type: "text_absent", text: "招待された方のみ" },
          ],
        },
      },
    ]);
    assert.equal(targets[0].triggerWhen.rules?.length, 3);
  });

  it("rules が無い・空配列ならエラー", () => {
    assert.match(loadError([{ ...base, triggerWhen: { type: "all_of" } }]), /rules（1件以上の配列）/);
    assert.match(
      loadError([{ ...base, triggerWhen: { type: "all_of", rules: [] } }]),
      /rules（1件以上の配列）/,
    );
  });

  it("子ルールに all_of / items_added は使えない", () => {
    const nested = loadError([
      {
        ...base,
        triggerWhen: {
          type: "all_of",
          rules: [{ type: "all_of", rules: [{ type: "text_present", text: "x" }] }],
        },
      },
    ]);
    assert.match(nested, /rules\[0\]\.type "all_of" は all_of の子ルールには使えません/);

    const items = loadError([
      {
        ...base,
        triggerWhen: {
          type: "all_of",
          rules: [{ type: "items_added", selector: "li", keyAttribute: "data-id" }],
        },
      },
    ]);
    assert.match(items, /rules\[0\]\.type "items_added" は all_of の子ルールには使えません/);
  });

  it("子ルールの必須項目の不足も位置つきで報告する", () => {
    const msg = loadError([
      {
        ...base,
        triggerWhen: {
          type: "all_of",
          rules: [{ type: "selector_exists" }, { type: "number_at_most", selector: ".p" }],
        },
      },
    ]);
    assert.match(msg, /rules\[0\]\.type "selector_exists" には selector が必須です/);
    assert.match(msg, /rules\[1\]\.type "number_at_most" には max（数値）が必須です/);
  });
});

describe("loadTargets: number_at_most", () => {
  it("selector と max があれば読み込める", () => {
    const targets = load([
      { ...base, triggerWhen: { type: "number_at_most", selector: ".price", max: 880 } },
    ]);
    assert.equal(targets[0].triggerWhen.max, 880);
  });

  it("max が無い・数値でないならエラー", () => {
    assert.match(
      loadError([{ ...base, triggerWhen: { type: "number_at_most", selector: ".p" } }]),
      /max（数値）が必須です/,
    );
    assert.match(
      loadError([{ ...base, triggerWhen: { type: "number_at_most", selector: ".p", max: "880" } }]),
      /max（数値）が必須です/,
    );
  });

  it("min は0以上かつ max 以下である必要がある", () => {
    assert.match(
      loadError([
        { ...base, triggerWhen: { type: "number_at_most", selector: ".p", max: 880, min: -1 } },
      ]),
      /min は0以上の数値である必要があります/,
    );
    assert.match(
      loadError([
        { ...base, triggerWhen: { type: "number_at_most", selector: ".p", max: 880, min: 1000 } },
      ]),
      /min は max 以下である必要があります/,
    );
  });
});
