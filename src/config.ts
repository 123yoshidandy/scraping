import { readFileSync } from "node:fs";
import type { Target, RuleType } from "./types.js";

const RULE_TYPES: RuleType[] = [
  "selector_exists",
  "selector_absent",
  "text_present",
  "text_absent",
  "items_added",
];

const WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle"];

const SELECTOR_RULES: RuleType[] = ["selector_exists", "selector_absent", "items_added"];
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

    const rule = item.triggerWhen;
    if (!isRecord(rule)) {
      errors.push(`${label()}: triggerWhen は必須です`);
    } else {
      const type = rule.type;
      if (typeof type !== "string" || !RULE_TYPES.includes(type as RuleType)) {
        errors.push(
          `${label()}: triggerWhen.type は ${RULE_TYPES.join(" | ")} のいずれかが必須です`,
        );
      } else {
        if (
          SELECTOR_RULES.includes(type as RuleType) &&
          (typeof rule.selector !== "string" || rule.selector.trim() === "")
        ) {
          errors.push(`${label()}: triggerWhen.type "${type}" には selector が必須です`);
        }
        if (
          TEXT_RULES.includes(type as RuleType) &&
          (typeof rule.text !== "string" || rule.text.trim() === "")
        ) {
          errors.push(`${label()}: triggerWhen.type "${type}" には text が必須です`);
        }
        if (type === "items_added") {
          if (typeof rule.keyAttribute !== "string" || rule.keyAttribute.trim() === "") {
            errors.push(`${label()}: triggerWhen.type "items_added" には keyAttribute が必須です`);
          }
          if (
            rule.labelSelector !== undefined &&
            (typeof rule.labelSelector !== "string" || rule.labelSelector.trim() === "")
          ) {
            errors.push(
              `${label()}: triggerWhen.labelSelector は空でない文字列である必要があります`,
            );
          }
        }
      }
    }

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
