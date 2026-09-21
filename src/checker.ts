import { mkdirSync } from "node:fs";
import path from "node:path";
import { errors as playwrightErrors } from "playwright";
import type { Browser, Page } from "playwright";
import { findNewItems, normalizeItems, type RawItem } from "./items.js";
import { DEFAULT_MIN, extractNumber } from "./numbers.js";
import type { Target, CheckResult, CheckStatus, ItemRef, TriggerRule } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_UNTIL = "domcontentloaded" as const;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DEFAULT_LOCALE = "ja-JP";
const DEFAULT_TIMEZONE = "Asia/Tokyo";
const SCREENSHOT_DIR = "screenshots";
/** 存在系ルール（selector_exists / text_present / items_added / number_at_most）で「不成立」と結論する前に待つ最大時間 */
const EXISTS_WAIT_CAP_MS = 10_000;
const TEXT_POLL_INTERVAL_MS = 500;

/**
 * ターゲットを1件チェックする。error の場合は1回だけリトライする（計2回試行）。
 * knownKeys は items_added 用の既知項目キー集合。undefined なら基準取得として扱い、新着は報告しない。
 */
export async function checkTarget(
  browser: Browser,
  target: Target,
  knownKeys?: ReadonlySet<string>,
): Promise<CheckResult> {
  let result = await runCheck(browser, target, knownKeys);
  if (result.status === "error") {
    result = await runCheck(browser, target, knownKeys);
  }
  return result;
}

async function runCheck(
  browser: Browser,
  target: Target,
  knownKeys: ReadonlySet<string> | undefined,
): Promise<CheckResult> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const context = await browser.newContext({
    userAgent: target.userAgent ?? DEFAULT_USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: target.locale ?? DEFAULT_LOCALE,
    timezoneId: target.timezoneId ?? DEFAULT_TIMEZONE,
  });
  const page = await context.newPage();
  let httpStatus: number | undefined;
  let pageTitle: string | undefined;

  async function finish(
    status: CheckStatus,
    error?: string,
    extra?: Pick<CheckResult, "items" | "newItems" | "value">,
  ): Promise<CheckResult> {
    let screenshotPath: string | undefined;
    if (status === "matched" || status === "error") {
      screenshotPath = await takeScreenshot(page, target.name, status);
    }
    return {
      targetName: target.name,
      status,
      checkedAt,
      elapsedMs: Date.now() - startedAt,
      httpStatus,
      pageTitle,
      error,
      screenshotPath,
      ...extra,
    };
  }

  try {
    const response = await page.goto(target.url, {
      waitUntil: target.waitUntil ?? DEFAULT_WAIT_UNTIL,
      timeout: timeoutMs,
    });
    httpStatus = response?.status();
    pageTitle = await page.title().catch(() => undefined);

    if (httpStatus !== undefined && httpStatus >= 400) {
      return await finish("error", `HTTP ${httpStatus}`);
    }
    if (target.extraWaitMs) {
      await page.waitForTimeout(target.extraWaitMs);
    }
    // サニティチェック: bot遮断ページや白紙ページを「条件成立」と誤検知しないための防波堤
    if (target.requireSelector) {
      const found = (await visibleCount(page, target.requireSelector)) > 0;
      if (!found) {
        return await finish(
          "error",
          `requireSelector "${target.requireSelector}" が見つかりません（ページが正しく表示されていない可能性）`,
        );
      }
    }

    const waitCapMs = Math.min(timeoutMs, EXISTS_WAIT_CAP_MS);
    if (target.triggerWhen.type === "items_added") {
      const rule = target.triggerWhen;
      const { elementCount, items } = await collectItems(page, rule, waitCapMs);
      // 0件は「不成立」ではなく判定不能として扱う。unmatched にすると、セレクタが古くなった期間に
      // seenItems が prune で空になり、修正後に全件が新着として通知されてしまう
      if (elementCount === 0) {
        return await finish(
          "error",
          `triggerWhen.selector "${rule.selector}" に一致する可視要素が0件です（一覧が空か、セレクタが古い可能性）`,
        );
      }
      if (items.length === 0) {
        return await finish(
          "error",
          `keyAttribute "${rule.keyAttribute}" を持つ要素が0件です（keyAttribute の指定ミスの可能性）`,
        );
      }
      const newItems = findNewItems(items, knownKeys);
      return await finish(newItems.length > 0 ? "matched" : "unmatched", undefined, {
        items,
        newItems,
      });
    }

    const { matched, value } = await evaluateRule(page, target.triggerWhen, waitCapMs);
    return await finish(matched ? "matched" : "unmatched", undefined, { value });
  } catch (e) {
    return await finish("error", errorMessage(e));
  } finally {
    await context.close().catch(() => {});
  }
}

/** ルール評価の結果。value は number_at_most で実際に読み取った数値（ログ・通知の根拠） */
interface RuleOutcome {
  matched: boolean;
  value?: number;
}

/** 1つの真偽ルールを評価する。all_of から子ルールを再帰的に評価するため rule 単体を受け取る */
async function evaluateRule(
  page: Page,
  rule: TriggerRule,
  waitCapMs: number,
): Promise<RuleOutcome> {
  switch (rule.type) {
    case "selector_exists":
      // 遅いハイドレーションを許容するため、可視になるまで短時間待ってから判定する
      try {
        await page
          .locator(rule.selector!)
          .filter({ visible: true })
          .first()
          .waitFor({ state: "visible", timeout: waitCapMs });
        return { matched: true };
      } catch (e) {
        if (e instanceof playwrightErrors.TimeoutError) return { matched: false };
        throw e;
      }
    case "selector_absent":
      return { matched: (await visibleCount(page, rule.selector!)) === 0 };
    case "text_present":
      return { matched: await pollForText(page, rule.text!, waitCapMs) };
    case "text_absent":
      // 読み取り失敗は「不在＝成立」ではなく error として扱う（throw は呼び出し元で error になる）
      return {
        matched: !includesNormalized(await page.innerText("body", { timeout: 5_000 }), rule.text!),
      };
    case "number_at_most": {
      const locator = page.locator(rule.selector!).filter({ visible: true }).first();
      try {
        await locator.waitFor({ state: "visible", timeout: waitCapMs });
      } catch (e) {
        // 価格が表示されない＝購入不可、というECの一般的な挙動に合わせ「不成立」とする。
        // bot遮断ページや白紙ページは requireSelector が error として弾く
        if (e instanceof playwrightErrors.TimeoutError) return { matched: false };
        throw e;
      }
      const text = await locator.innerText({ timeout: 5_000 });
      const value = extractNumber(text);
      if (value === undefined) {
        // 要素はあるのに数値が読めない = セレクタが古くなった可能性。判定不能として error にする
        throw new Error(
          `number_at_most: セレクタ "${rule.selector}" から数値を取り出せません: "${text.replace(/\s+/g, " ").slice(0, 50)}"`,
        );
      }
      return { matched: value >= (rule.min ?? DEFAULT_MIN) && value <= rule.max!, value };
    }
    case "all_of": {
      // 1つでも不成立なら残りは評価しない。観測値は最初に得られたものを親に伝える
      let value: number | undefined;
      for (const child of rule.rules!) {
        const outcome = await evaluateRule(page, child, waitCapMs);
        value ??= outcome.value;
        if (!outcome.matched) return { matched: false, value };
      }
      return { matched: true, value };
    }
    case "items_added":
      // runCheck 側で先に分岐しているため到達しない（switch の網羅性のために残す）
      throw new Error("items_added は evaluateRule では処理しない");
  }
}

async function visibleCount(page: Page, selector: string): Promise<number> {
  return page.locator(selector).filter({ visible: true }).count();
}

/**
 * items_added 用: 一覧の項目要素を抽出する。
 * elementCount は keyAttribute の有無を問わず一致した可視要素の数（0件を error にするための判定材料）。
 */
async function collectItems(
  page: Page,
  rule: TriggerRule,
  waitCapMs: number,
): Promise<{ elementCount: number; items: ItemRef[] }> {
  const locator = page.locator(rule.selector!).filter({ visible: true });
  // selector_exists と同様、遅いレンダリングを許容するため最初の要素が可視になるまで短時間待つ
  try {
    await locator.first().waitFor({ state: "visible", timeout: waitCapMs });
  } catch (e) {
    if (e instanceof playwrightErrors.TimeoutError) return { elementCount: 0, items: [] };
    throw e;
  }
  // このコールバックはブラウザ側で実行される。引数以外（このモジュールの変数など）は参照できない
  const raw = await locator.evaluateAll(
    (els, { keyAttribute, labelSelector }): RawItem[] =>
      els.map((el) => {
        const labelEl = labelSelector ? el.querySelector(labelSelector) : el;
        return {
          key: el.getAttribute(keyAttribute),
          label:
            labelEl instanceof HTMLElement ? labelEl.innerText : (labelEl?.textContent ?? null),
          // anchor.href はブラウザが絶対URLに解決済み
          url: el.querySelector<HTMLAnchorElement>("a[href]")?.href ?? null,
        };
      }),
    { keyAttribute: rule.keyAttribute!, labelSelector: rule.labelSelector ?? null },
  );
  return { elementCount: raw.length, items: normalizeItems(raw) };
}

async function pollForText(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await page.innerText("body", { timeout: 5_000 }).catch(() => null);
    if (body !== null && includesNormalized(body, text)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(TEXT_POLL_INTERVAL_MS);
  }
}

/** 大文字小文字を無視し、連続する空白を1つに正規化した上での部分一致 */
function includesNormalized(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

async function takeScreenshot(
  page: Page,
  targetName: string,
  status: string,
): Promise<string | undefined> {
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(SCREENSHOT_DIR, `${slugify(targetName)}-${status}-${ts}.png`);
    await page.screenshot({ path: file, fullPage: true, timeout: 10_000 });
    return file;
  } catch {
    // ナビゲーション失敗直後などスクリーンショットが取れないことは正常系として許容する
    return undefined;
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "target"
  );
}

function errorMessage(e: unknown): string {
  // Playwright のエラーは2行目以降に Call log が続くため1行目のみ記録する
  const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}
