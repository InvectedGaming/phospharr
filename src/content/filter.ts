import { eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { channels } from "../db/schema.ts";
import { getSetting } from "../settings.ts";
import { isAdult } from "./adult.ts";

/**
 * Auto-hide reconciliation. Brings every channel's hidden state in line with the
 * admin's content settings — adult-content hiding and whole-category hiding — in a
 * SINGLE pass so the two can't fight each other.
 *
 * It only ever touches channels it auto-hid before (hiddenReason 'adult' or
 * 'cat:<name>') or that are currently visible. Channels hidden by the user or a
 * rule (any other hiddenReason) are left alone. Fully reversible: drop a category
 * from the list or turn off adult-hiding and the matching channels reappear.
 */

const isAutoReason = (r: string | null): boolean => r === "adult" || (typeof r === "string" && r.startsWith("cat:"));

export async function reconcileAutoHides(): Promise<number> {
  const hideAdult = await getSetting("content.hideAdult");
  const hiddenCats = new Set((await getSetting("content.hiddenCategories")) ?? []);
  const rows = await db.select().from(channels);

  let changed = 0;
  for (const ch of rows) {
    const adult = hideAdult && isAdult(ch.category, ch.name);
    const catHidden = ch.category != null && hiddenCats.has(ch.category);
    const reason = adult ? "adult" : catHidden ? `cat:${ch.category}` : null;
    const auto = isAutoReason(ch.hiddenReason);

    if (reason) {
      if (!ch.isHidden) {
        await db.update(channels).set({ isHidden: true, hiddenReason: reason }).where(eq(channels.id, ch.id));
        changed++;
      } else if (auto && ch.hiddenReason !== reason) {
        // e.g. a channel that was category-hidden now also matches adult — keep the reason accurate.
        await db.update(channels).set({ hiddenReason: reason }).where(eq(channels.id, ch.id));
        changed++;
      }
      // already hidden by the user/a rule → leave it.
    } else if (auto) {
      // We hid it, but it no longer should be → restore it.
      await db.update(channels).set({ isHidden: false, hiddenReason: null }).where(eq(channels.id, ch.id));
      changed++;
    }
  }
  return changed;
}

/** Categories with channel counts + whether the admin has hidden the whole group. */
export async function listCategories(): Promise<{ category: string; total: number; hidden: boolean }[]> {
  const hiddenCats = new Set((await getSetting("content.hiddenCategories")) ?? []);
  const rows = sqlite.query(
    "SELECT category, COUNT(*) AS total FROM channels WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY total DESC",
  ).all() as { category: string; total: number }[];
  return rows.map((r) => ({ category: r.category, total: r.total, hidden: hiddenCats.has(r.category) }));
}
