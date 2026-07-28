// src/webview/ui/components/SummaryBar.tsx
import type { SessionCard } from "../types.js";

interface Props {
  sessions: SessionCard[];
}

/** Aggregate totals for the currently displayed (filtered/searched) sessions. */
export function SummaryBar({ sessions }: Props) {
  if (sessions.length === 0) return null;

  let totalCost = 0;
  let hasCost = false;
  let totalMessages = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const s of sessions) {
    if (s.cost != null) { totalCost += s.cost; hasCost = true; }
    totalMessages += s.messageCount;
    totalAdded += s.linesAdded;
    totalRemoved += s.linesRemoved;
  }

  const count = sessions.length;
  const parts: string[] = [`${count} ${count === 1 ? "session" : "sessions"}`];
  parts.push(`${totalMessages} msgs`);
  if (hasCost) parts.push(`$${totalCost.toFixed(2)}`);
  if (totalAdded > 0 || totalRemoved > 0) parts.push(`+${totalAdded}/-${totalRemoved}`);

  return <div class="summary-bar">{parts.join(" · ")}</div>;
}
