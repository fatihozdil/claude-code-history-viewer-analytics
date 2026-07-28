// Standard, first-party API-equivalent prices in USD per 1M text tokens.
// Provider subscription plans and priority/batch/regional modes may bill differently.

export interface ModelPrice { input: number; output: number; cacheWrite: number; cacheRead: number }
export interface TokenCounts { input: number; output: number; cacheCreation: number; cacheRead: number }

const p = (input: number, output: number, cacheRead: number, cacheWrite = input): ModelPrice =>
  ({ input, output, cacheWrite, cacheRead });

interface PriceRule {
  test: (model: string) => boolean;
  sql: string;
  price: ModelPrice | (() => ModelPrice);
}

const includes = (...parts: string[]) => (model: string): boolean => parts.every((part) => model.includes(part));
const beforeSonnet5Increase = (): boolean => Date.now() < Date.UTC(2026, 8, 1);
const sonnet5Price = (): ModelPrice => beforeSonnet5Increase() ? p(2, 10, 0.2, 2.5) : p(3, 15, 0.3, 3.75);

// Ordered most-specific-first. SQL is generated from this same table so chat
// and analytics cannot silently drift apart again.
const RULES: PriceRule[] = [
  // OpenAI current flagship families (standard, short-context rates).
  { test: includes("gpt-5.6", "sol"), sql: "model LIKE '%gpt-5.6%' AND model LIKE '%sol%'", price: p(5, 30, 0.5, 6.25) },
  { test: includes("gpt-5.6", "terra"), sql: "model LIKE '%gpt-5.6%' AND model LIKE '%terra%'", price: p(2.5, 15, 0.25, 3.125) },
  { test: includes("gpt-5.6", "luna"), sql: "model LIKE '%gpt-5.6%' AND model LIKE '%luna%'", price: p(1, 6, 0.1, 1.25) },
  { test: includes("gpt-5.5", "pro"), sql: "model LIKE '%gpt-5.5%' AND model LIKE '%pro%'", price: p(30, 180, 30) },
  { test: includes("gpt-5.5"), sql: "model LIKE '%gpt-5.5%'", price: p(5, 30, 0.5) },
  { test: includes("gpt-5.4", "mini"), sql: "model LIKE '%gpt-5.4%' AND model LIKE '%mini%'", price: p(0.75, 4.5, 0.075) },
  { test: includes("gpt-5.4", "nano"), sql: "model LIKE '%gpt-5.4%' AND model LIKE '%nano%'", price: p(0.2, 1.25, 0.02) },
  { test: includes("gpt-5.4", "pro"), sql: "model LIKE '%gpt-5.4%' AND model LIKE '%pro%'", price: p(30, 180, 30) },
  { test: includes("gpt-5.4"), sql: "model LIKE '%gpt-5.4%'", price: p(2.5, 15, 0.25) },
  { test: (m) => m.includes("gpt-5.3-codex") || m.includes("gpt-5.2"), sql: "model LIKE '%gpt-5.3-codex%' OR model LIKE '%gpt-5.2%'", price: p(1.75, 14, 0.175) },
  { test: includes("gpt-5", "mini"), sql: "model LIKE '%gpt-5%' AND model LIKE '%mini%'", price: p(0.25, 2, 0.025) },
  { test: includes("gpt-5", "nano"), sql: "model LIKE '%gpt-5%' AND model LIKE '%nano%'", price: p(0.05, 0.4, 0.005) },
  { test: includes("gpt-5", "pro"), sql: "model LIKE '%gpt-5%' AND model LIKE '%pro%'", price: p(15, 120, 15) },
  { test: includes("gpt-5"), sql: "model LIKE '%gpt-5%'", price: p(1.25, 10, 0.125) },
  { test: includes("gpt-4.1", "mini"), sql: "model LIKE '%gpt-4.1%' AND model LIKE '%mini%'", price: p(0.4, 1.6, 0.1) },
  { test: includes("gpt-4.1"), sql: "model LIKE '%gpt-4.1%'", price: p(2, 8, 0.5) },
  { test: includes("gpt-4o-mini"), sql: "model LIKE '%gpt-4o-mini%'", price: p(0.15, 0.6, 0.075) },
  { test: includes("gpt-4o"), sql: "model LIKE '%gpt-4o%'", price: p(2.5, 10, 1.25) },

  // Google standard text-token rates.
  { test: includes("gemini-3.5", "flash"), sql: "model LIKE '%gemini-3.5%' AND model LIKE '%flash%'", price: p(1.5, 9, 0.15) },
  { test: includes("gemini-3.1", "flash-lite"), sql: "model LIKE '%gemini-3.1%' AND model LIKE '%flash-lite%'", price: p(0.25, 1.5, 0.025) },
  { test: includes("gemini-3.1", "pro"), sql: "model LIKE '%gemini-3.1%' AND model LIKE '%pro%'", price: p(2, 12, 0.2) },
  { test: includes("gemini-3", "flash"), sql: "model LIKE '%gemini-3%' AND model LIKE '%flash%'", price: p(0.5, 3, 0.05) },
  { test: includes("gemini-2.5", "flash-lite"), sql: "model LIKE '%gemini-2.5%' AND model LIKE '%flash-lite%'", price: p(0.1, 0.4, 0.01) },
  { test: includes("gemini-2.5", "flash"), sql: "model LIKE '%gemini-2.5%' AND model LIKE '%flash%'", price: p(0.3, 2.5, 0.03) },
  { test: includes("gemini-2.5", "pro"), sql: "model LIKE '%gemini-2.5%' AND model LIKE '%pro%'", price: p(1.25, 10, 0.125) },
  { test: includes("gemini-2.0", "flash-lite"), sql: "model LIKE '%gemini-2.0%' AND model LIKE '%flash-lite%'", price: p(0.075, 0.3, 0.075) },
  { test: includes("gemini-2.0", "flash"), sql: "model LIKE '%gemini-2.0%' AND model LIKE '%flash%'", price: p(0.1, 0.4, 0.025) },
  { test: includes("gemini-1.5", "pro"), sql: "model LIKE '%gemini-1.5%' AND model LIKE '%pro%'", price: p(1.25, 5, 0.3125) },
  { test: includes("gemini-1.5", "flash"), sql: "model LIKE '%gemini-1.5%' AND model LIKE '%flash%'", price: p(0.075, 0.3, 0.01875) },

  // DeepSeek V4 standard rates.
  { test: includes("deepseek", "flash"), sql: "model LIKE '%deepseek%' AND model LIKE '%flash%'", price: p(0.14, 0.28, 0.0028) },
  { test: includes("deepseek"), sql: "model LIKE '%deepseek%'", price: p(0.435, 0.87, 0.003625) },

  // Anthropic: keep legacy generations distinct from current aliases.
  { test: (m) => m.includes("opus-4-1") || m.includes("opus-4-202") || m.endsWith("opus-4"), sql: "model LIKE '%opus-4-1%' OR model LIKE '%opus-4-202%' OR model = 'claude-opus-4'", price: p(15, 75, 1.5, 18.75) },
  { test: includes("opus"), sql: "model LIKE '%opus%'", price: p(5, 25, 0.5, 6.25) },
  { test: includes("sonnet-5"), sql: "model LIKE '%sonnet-5%'", price: sonnet5Price },
  { test: includes("sonnet"), sql: "model LIKE '%sonnet%'", price: p(3, 15, 0.3, 3.75) },
  { test: (m) => m.includes("haiku-3-5") || m.includes("3-5-haiku"), sql: "model LIKE '%haiku-3-5%' OR model LIKE '%3-5-haiku%'", price: p(0.8, 4, 0.08, 1) },
  { test: includes("haiku"), sql: "model LIKE '%haiku%'", price: p(1, 5, 0.1, 1.25) },
  { test: (m) => m.includes("fable") || m.includes("mythos"), sql: "model LIKE '%fable%' OR model LIKE '%mythos%'", price: p(10, 50, 1, 12.5) },
];

const DEFAULT_CLAUDE = p(3, 15, 0.3, 3.75);
const ZERO = p(0, 0, 0, 0);

export function priceForModel(model: string | null | undefined): ModelPrice {
  if (!model) return DEFAULT_CLAUDE;
  const normalized = model.toLowerCase();
  for (const rule of RULES) {
    if (rule.test(normalized)) return typeof rule.price === "function" ? rule.price() : rule.price;
  }
  return normalized.includes("claude") ? DEFAULT_CLAUDE : ZERO;
}

/** True only when a model has a deliberate rule (not a generic fallback). */
export function hasExplicitPriceForModel(model: string): boolean {
  const normalized = model.toLowerCase();
  const knownFamilies = [
    /^gpt-5\.6-(sol|terra|luna)(?:-|$)/,
    /^gpt-5\.5(?:-pro)?(?:-|$)/,
    /^gpt-5\.4(?:-(?:mini|nano|pro|codex|cyber))?(?:-|$)/,
    /^gpt-5\.3-codex(?:-|$)/,
    /^gpt-5\.2(?:-codex|-pro)?(?:-|$)/,
    /^gpt-5(?:-(?:mini|nano|pro))?(?:-|$)/,
    /^gpt-4\.1(?:-mini)?(?:-|$)/,
    /^gpt-4o(?:-mini)?(?:-|$)/,
    /^gemini-(?:3\.5-flash|3\.1-(?:pro|flash-lite)|3-flash|2\.5-(?:pro|flash|flash-lite)|2\.0-(?:flash|flash-lite)|1\.5-(?:pro|flash))(?:-|$)/,
    /^deepseek-(?:v4-(?:flash|pro)|chat|reasoner)(?:-|$)/,
    /^claude-(?:opus-(?:4-[5-8]|4-1|4)|sonnet-(?:5|4-[456])|haiku-(?:4-5|3-5)|3-5-haiku|fable-5|mythos-5)(?:-|$)/,
  ];
  return knownFamilies.some((pattern) => pattern.test(normalized));
}

export function costForTokens(model: string | null | undefined, t: TokenCounts): number {
  const price = priceForModel(model);
  return (t.input * price.input + t.output * price.output + t.cacheCreation * price.cacheWrite + t.cacheRead * price.cacheRead) / 1_000_000;
}

function sqlCost(price: ModelPrice): string {
  return `COALESCE(input_tokens,0)*${price.input} + COALESCE(output_tokens,0)*${price.output} + COALESCE(cache_creation_tokens,0)*${price.cacheWrite} + COALESCE(cache_read_tokens,0)*${price.cacheRead}`;
}

const sqlCases = RULES.map((rule) => {
  if (rule.price === sonnet5Price) {
    return `WHEN ${rule.sql} THEN CASE WHEN date('now') < date('2026-09-01') THEN ${sqlCost(p(2, 10, 0.2, 2.5))} ELSE ${sqlCost(p(3, 15, 0.3, 3.75))} END`;
  }
  const price = typeof rule.price === "function" ? rule.price() : rule.price;
  return `WHEN ${rule.sql} THEN ${sqlCost(price)}`;
}).join("\n    ");

export const MESSAGE_COST_SQL = `(CASE
    ${sqlCases}
    WHEN model IS NULL OR model = '' OR model LIKE '%claude%' THEN ${sqlCost(DEFAULT_CLAUDE)}
    ELSE 0
  END) / 1000000.0`;
