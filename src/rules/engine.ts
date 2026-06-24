import { db } from "../db/index.ts";
import { channels, streams, rules, type Rule } from "../db/schema.ts";
import { eq } from "drizzle-orm";

/**
 * Declarative auto-management. Rules are stored as { condition, action } JSON
 * and applied reactively after ingest. Hiding is reversible (sets isHidden +
 * hiddenReason) — never deletes.
 *
 * condition: { field, op, value }   field ∈ channel/stream attributes
 * action:    { set, value }         set ∈ isHidden | category | name
 */

type Op = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "matches";

interface Condition {
  field: string;
  op: Op;
  value: string | number;
}
interface Action {
  set: "isHidden" | "category" | "name";
  value: string | number | boolean;
}

function evalOp(op: Op, left: unknown, right: string | number): boolean {
  if (left == null) return false;
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "contains":
      return String(left).toLowerCase().includes(String(right).toLowerCase());
    case "matches":
      try {
        return new RegExp(String(right), "i").test(String(left));
      } catch {
        return false;
      }
  }
}

/** Best resolution among a channel's streams (for resolution-based rules). */
async function channelResolution(channelId: number): Promise<number> {
  const rows = await db
    .select({ resolution: streams.resolution })
    .from(streams)
    .where(eq(streams.channelId, channelId));
  return rows.reduce((max, r) => Math.max(max, r.resolution ?? 0), 0);
}

export async function applyRules(): Promise<{ applied: number; affected: number }> {
  const activeRules = (await db.select().from(rules).where(eq(rules.enabled, true)))
    .slice()
    .sort((a, b) => a.priority - b.priority) as Rule[];

  const chans = await db.select().from(channels);
  let affected = 0;

  for (const ch of chans) {
    const resolution = await channelResolution(ch.id);
    const ctx: Record<string, unknown> = {
      name: ch.name,
      category: ch.category,
      resolution,
      country: ch.canonicalId?.split(".").pop(),
      isHidden: ch.isHidden,
    };

    const updates: Partial<typeof channels.$inferInsert> = {};
    for (const rule of activeRules) {
      const cond = rule.condition as unknown as Condition;
      const act = rule.action as unknown as Action;
      if (!evalOp(cond.op, ctx[cond.field], cond.value)) continue;

      if (act.set === "isHidden" && act.value) {
        updates.isHidden = true;
        updates.hiddenReason = `rule:${rule.id}`;
      } else if (act.set === "category") {
        updates.category = String(act.value);
      } else if (act.set === "name") {
        updates.name = String(act.value);
      }
    }

    if (Object.keys(updates).length > 0) {
      await db.update(channels).set(updates).where(eq(channels.id, ch.id));
      affected++;
    }
  }

  return { applied: activeRules.length, affected };
}
