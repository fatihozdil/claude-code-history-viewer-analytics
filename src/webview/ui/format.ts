// src/webview/ui/format.ts
// Display formatting utilities. Runs in the webview (browser).

import type { SessionCard, SortMode } from "./types.js";

export function relativeTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/** Absolute localized datetime, for a card's hover tooltip. */
export function absoluteTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function costPart(cost: number | null): string | null {
  if (cost == null) return null;
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return `$${cost.toFixed(6)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** Multi-line metadata for expanded mode. */
export function formatExpanded(card: SessionCard): string {
  const parts: string[] = [relativeTime(card.updatedAt || card.createdAt), `${card.messageCount} msgs`];
  if (card.filesModified > 0) parts.push(`${card.filesModified} files`);
  const cost = costPart(card.cost);
  if (cost) parts.push(cost);
  if (card.linesAdded > 0 || card.linesRemoved > 0)
    parts.push(`+${card.linesAdded}/-${card.linesRemoved}`);
  return parts.filter(Boolean).join(" · ");
}

/** Single-line metadata for compact mode. */
export function formatCompact(card: SessionCard): string {
  const time = relativeTime(card.updatedAt || card.createdAt);
  const parts = [`${card.messageCount} msgs`, time];
  const cost = costPart(card.cost);
  if (cost) parts.push(cost);
  return parts.filter(Boolean).join(" · ");
}

export const SORT_LABELS: Record<SortMode, string> = {
  newest: "Newest",
  oldest: "Oldest",
  messages: "Most Messages",
  activity: "Recent Activity",
  cost: "Most Expensive",
  impact: "Most Changes",
};
