import { readFileSync } from "node:fs";
import type { Target, RuleType } from "./types.js";

const RULE_TYPES: RuleType[] = [
  "selector_exists",
  "selector_absent",
  "text_present",
  "text_absent",
  "items_added",
  "number_at_most",
  "all_of",
];

/** all_of の子ルールに書けるもの。差分ルール（items_added）と入れ子の all_of は通知の意味が混ざるため除く */
const NESTABLE_RULES: RuleType[] = [
  "selector_exists",
  "selector_absent",
  "text_present",
  "text_absent",
  "number_at_most",
];

const WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle"];

const SELECTOR_RULES: RuleType[] = [
  "selector_exists",
  "selector_absent",
  "items_added",
  "number_at_most",
];
const TEXT_RULES: RuleType[] = ["text_present", "text_absent"];

export class ConfigError extends Error {}

export function loadTargets(path: string): Target[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new ConfigError(`設定ファイルを読み込めません: ${path} (${String(e)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`設定ファイルが正しいJSONではありません: ${path} (${String(e)})`);
  }

  if (!Array.isArray(parsed)) {
    throw new ConfigError("設定ファイルのトップレベルは配列である必要があります");
  }

  const errors: string[] = [];
  const seenNames = new Set<string>();

  parsed.forEach((item, i) => {
    const label = () =>
      isRecord(item) && typeof item.name === "string" && item.name !== ""
        ? `targets[${i}] (${item.name})`
        : `targets[${i}]`;

    if (!isRecord(item)) {
      errors.push(`${label()}: オブジェクトである必要があります`);
      return;
    }

    if (typeof item.name !== "string" || item.name.trim() === "") {
      errors.push(`${label()}: name は空でない文字列が必須です`);
    } else if (seenNames.has(item.name)) {
      errors.push(`${label()}: name "${item.name}" が重複しています`);
    } else {
      seenNames.add(item.name);
    }

    if (typeof item.url !== "string" || !isHttpUrl(item.url)) {
      errors.push(`${label()}: url は http(s) の正しいURLが必須です`);
    }

    validateRule(item.triggerWhen, label, errors, false);

    validateOptionalString(item, "description", label, errors);
    validateOptionalString(item, "requireSelector", label, errors);
    validateOptionalString(item, "userAgent", label, errors);
    validateOptionalString(item, "locale", label, errors);
    validateOptionalString(item, "timezoneId", label, errors);

    if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
      errors.push(`${label()}: enabled は真偽値である必要があります`);
    }
    validateOptionalPositiveNumber(item, "timeoutMs", label, errors);
    validateOptionalNonNegativeNumber(item, "extraWaitMs", label, errors);
    if (
      item.waitUntil !== undefined &&
      (typeof item.waitUntil !== "string" || !WAIT_UNTIL_VALUES.includes(item.waitUntil))
    ) {
      errors.push(
        `${label()}: waitUntil は ${WAIT_UNTIL_VALUES.join(" | ")} のいずれかである必要があります`,
      );
    }
  });

  if (errors.length > 0) {
    throw new ConfigError(`設定ファイルにエラーがあります:\n  - ${errors.join("\n  - ")}`);
  }

  return parsed as Target[];
}

/**
 * triggerWhen を検証する。all_of の子ルールを再帰的に検証するため rule 単体を受け取る。
 * nested=true のときは all_of の子として許可された type だけを受け付ける。
 */
function validateRule(
  rule: unknown,
  label: () => string,
  errors: string[],
  nested: boolean,
  path = "triggerWhen",
): void {
  if (!isRecord(rule)) {
    errors.push(`${label()}: ${path} は必須です`);
    return;
  }
  const type = rule.type;
  if (typeof type !== "string" || !RULE_TYPES.includes(type as RuleType)) {
    errors.push(`${label()}: ${path}.type は ${RULE_TYPES.join(" | ")} のいずれかが必須です`);
    return;
  }
  if (nested && !NESTABLE_RULES.includes(type as RuleType)) {
    errors.push(
      `${label()}: ${path}.type "${type}" は all_of の子ルールには使えません（使えるのは ${NESTABLE_RULES.join(" | ")}）`,
    );
    return;
  }

  if (
    SELECTOR_RULES.includes(type as RuleType) &&
    (typeof rule.selector !== "string" || rule.selector.trim() === "")
  ) {
    errors.push(`${label()}: ${path}.type "${type}" には selector が必須です`);
  }
  if (
    TEXT_RULES.includes(type as RuleType) &&
    (typeof rule.text !== "string" || rule.text.trim() === "")
  ) {
    errors.push(`${label()}: ${path}.type "${type}" には text が必須です`);
  }

  if (type === "items_added") {
    if (typeof rule.keyAttribute !== "string" || rule.keyAttribute.trim() === "") {
      errors.push(`${label()}: ${path}.type "items_added" には keyAttribute が必須です`);
    }
    if (
      rule.labelSelector !== undefined &&
      (typeof rule.labelSelector !== "string" || rule.labelSelector.trim() === "")
    ) {
      errors.push(`${label()}: ${path}.labelSelector は空でない文字列である必要があります`);
    }
  }

  if (type === "number_at_most") {
    const max = rule.max;
    if (typeof max !== "number" || !Number.isFinite(max)) {
      errors.push(`${label()}: ${path}.type "number_at_most" には max（数値）が必須です`);
    }
    if (rule.min !== undefined) {
      if (typeof rule.min !== "number" || !Number.isFinite(rule.min) || rule.min < 0) {
        errors.push(`${label()}: ${path}.min は0以上の数値である必要があります`);
      } else if (typeof max === "number" && Number.isFinite(max) && rule.min > max) {
        errors.push(`${label()}: ${path}.min は max 以下である必要があります`);
      }
    }
  }

  if (type === "all_of") {
    if (!Array.isArray(rule.rules) || rule.rules.length === 0) {
      errors.push(`${label()}: ${path}.type "all_of" には rules（1件以上の配列）が必須です`);
    } else {
      rule.rules.forEach((child, i) => {
        validateRule(child, label, errors, true, `${path}.rules[${i}]`);
      });
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function validateOptionalString(
  item: Record<string, unknown>,
  key: string,
  label: () => string,
  errors: string[],
): void {
  const v = item[key];
  if (v !== undefined && (typeof v !== "string" || v.trim() === "")) {
    errors.push(`${label()}: ${key} は空でない文字列である必要があります`);
  }
}

function validateOptionalPositiveNumber(
  item: Record<string, unknown>,
  key: string,
  label: () => string,
  errors: string[],
): void {
  const v = item[key];
  if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
    errors.push(`${label()}: ${key} は正の数値である必要があります`);
  }
}

function validateOptionalNonNegativeNumber(
  item: Record<string, unknown>,
  key: string,
  label: () => string,
  errors: string[],
): void {
  const v = item[key];
  if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
    errors.push(`${label()}: ${key} は0以上の数値である必要があります`);
  }
}
