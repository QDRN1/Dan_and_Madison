import { useEffect, useState } from "react";
import type { AchievementProgress } from "@qdrn/shared";
import { api } from "../api";

export function AchievementsPanel(): JSX.Element {
  const [list, setList] = useState<AchievementProgress[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.achievements().then((r) => alive && setList(r.achievements)).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!list) return <div className="muted" style={{ padding: 12 }}>Loading…</div>;

  const unlocked = list.filter((a) => a.count > 0).length;
  // Sort: earned first (most-recently unlocked at the top), then locked
  // in their natural definition order. Within earned, prefer higher count
  // as a tiebreaker so "century_day 14×" sits above a single-fire badge.
  const sorted = [...list].sort((a, b) => {
    const aEarned = a.count > 0 ? 1 : 0;
    const bEarned = b.count > 0 ? 1 : 0;
    if (aEarned !== bEarned) return bEarned - aEarned;
    if (aEarned) {
      const aLast = a.lastAt ?? 0;
      const bLast = b.lastAt ?? 0;
      if (aLast !== bLast) return bLast - aLast;
      return b.count - a.count;
    }
    return 0;
  });

  return (
    <div className="scroll" style={{ flex: 1 }}>
      <div className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
        {unlocked} of {list.length} unlocked · keep flying to discover more
      </div>
      <div className="ach-grid">
        {sorted.map((a) => {
          const earned = a.count > 0;
          return (
            <div key={a.id} className={`ach${earned ? " earned" : ""}`}>
              <div className="ach-icon" aria-hidden="true">{earned ? a.icon : "🔒"}</div>
              <div className="ach-text">
                <div className="ach-title">{earned ? a.title : "???"}</div>
                <div className="ach-hint">{a.hint}</div>
              </div>
              {earned && a.count > 1 && (
                <div className="ach-count" title={`Achieved ${a.count} times`}>{a.count}×</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
