import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  awaitHostSlot,
  groupTargetsByHost,
  pendingWaitMs,
  resetHostSlots,
  runWithConcurrency,
} from "./throttle.js";
import type { Target } from "./types.js";

describe("pendingWaitMs", () => {
  it("初回（記録なし）は待たない", () => {
    assert.equal(pendingWaitMs(undefined, 1000), 0);
  });

  it("間隔が空いていなければ残り時間を返す", () => {
    assert.equal(pendingWaitMs(1000, 2000, 5000), 4000);
  });

  it("間隔を満たしていれば待たない", () => {
    assert.equal(pendingWaitMs(1000, 6000, 5000), 0);
    assert.equal(pendingWaitMs(1000, 9999, 5000), 0);
  });
});

describe("awaitHostSlot", () => {
  it("ホストが異なれば待たない", async () => {
    resetHostSlots();
    assert.equal(await awaitHostSlot("https://a.example.com/1"), 0);
    assert.equal(await awaitHostSlot("https://b.example.com/1"), 0);
  });

  it("URL が不正なら待たない", async () => {
    resetHostSlots();
    assert.equal(await awaitHostSlot("not a url"), 0);
  });
});

function target(name: string, url: string): Target {
  return { name, url, triggerWhen: { type: "text_present", text: "x" } };
}

describe("groupTargetsByHost", () => {
  it("同じホストのターゲットを1つにまとめ、設定ファイルの順序を保つ", () => {
    const groups = groupTargetsByHost([
      target("a1", "https://a.example.com/1"),
      target("b1", "https://b.example.com/1"),
      target("a2", "https://a.example.com/2"),
      target("a3", "http://a.example.com/3"),
    ]);
    assert.deepEqual(
      groups.map((g) => g.map((t) => t.name)),
      [["a1", "a2", "a3"], ["b1"]],
    );
  });

  it("URL が不正なターゲットは単独のグループになる", () => {
    const groups = groupTargetsByHost([target("bad", "not a url"), target("ok", "https://a.test/1")]);
    assert.equal(groups.length, 2);
  });
});

describe("runWithConcurrency", () => {
  it("すべてのタスクを実行し、同時実行数が上限を超えない", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      done.push(i);
      running--;
    });
    await runWithConcurrency(tasks, 3);
    assert.equal(done.length, 10);
    assert.deepEqual([...done].sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i));
    assert.ok(peak <= 3, `同時実行数が上限を超えました: ${peak}`);
  });

  it("タスクが0件でも正常に終わる", async () => {
    await runWithConcurrency([], 4);
  });
});
