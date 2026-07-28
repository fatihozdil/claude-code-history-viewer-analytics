#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { hasExplicitPriceForModel } from "../out-test/src/services/pricing.js";

const SOURCES = [
  ["Anthropic", "https://platform.claude.com/docs/en/about-claude/pricing"],
  ["OpenAI", "https://developers.openai.com/api/docs/pricing"],
  ["Google", "https://ai.google.dev/gemini-api/docs/pricing"],
  ["DeepSeek", "https://api-docs.deepseek.com/quick_start/pricing/"],
];

function normalize(value) {
  return value.toLowerCase().replace(/[),;:`'"<>]+$/g, "").replace(/\.$/, "");
}

function extractModels(html) {
  const text = html.replace(/&nbsp;/g, " ").replace(/&#x2F;|&#47;/g, "/");
  const found = new Set();
  for (const match of text.matchAll(/\b(?:gpt|gemini|deepseek)-[a-z0-9][a-z0-9._-]*/gi)) {
    const model = normalize(match[0]);
    if (/^gpt-(?:4|5)/.test(model)) found.add(model);
    else if (model.startsWith("deepseek-")) found.add(model);
    else if (model.startsWith("gemini-") && !/(?:image|audio|tts|live|translate|computer-use)/.test(model)) found.add(model);
  }
  // Anthropic's table primarily uses human-readable names rather than IDs.
  for (const match of text.matchAll(/Claude\s+(Opus|Sonnet|Haiku|Fable|Mythos)\s+([0-9]+(?:\.[0-9]+)?)/gi)) {
    found.add(`claude-${match[1].toLowerCase()}-${match[2].replace(".", "-")}`);
  }
  return found;
}

async function main() {
  const detected = new Map();
  const failures = [];
  for (const [provider, url] of SOURCES) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "claude-history-pricing-audit/1.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      detected.set(provider, extractModels(await response.text()));
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const unsupported = [];
  for (const [provider, models] of detected) {
    for (const model of models) {
      if (!hasExplicitPriceForModel(model)) unsupported.push({ provider, model });
    }
  }
  unsupported.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  const lines = ["### Automated new-model scan", ""];
  if (unsupported.length) {
    lines.push(`Found **${unsupported.length} model IDs/names without an explicit pricing rule**:`, "");
    for (const item of unsupported) lines.push(`- [ ] ${item.provider}: \`${item.model}\``);
  } else {
    lines.push("No newly advertised models without an explicit pricing rule were detected.");
  }
  if (failures.length) {
    lines.push("", "Source fetch failures (manual review required):", "");
    for (const failure of failures) lines.push(`- ${failure}`);
  }
  lines.push("", "This scan detects names only; pricing values and tier semantics still require review.");
  const report = lines.join("\n");
  process.stdout.write(`${report}\n`);

  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `pricing_report_${Date.now()}`;
    await fs.appendFile(process.env.GITHUB_OUTPUT, `report<<${delimiter}\n${report}\n${delimiter}\nmissing_count=${unsupported.length}\n`);
  }
}

await main();
