import { useEffect, useState } from "react";
import type { AchievementProgress } from "@qdrn/shared";
import { api } from "../api";

export function AchievementsPanel(): JSX.Element {
  const [list, setList] = useState<AchievementProgress[] | null>(null);
  const [selected, setSelected] = useState<AchievementProgress | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.achievements().then((r) => alive && setList(r.achievements)).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (!list) return <div className="muted" style={{ padding: 12 }}>Loading…</div>;

  const unlocked = list.filter((a) => a.count > 0).length;
  // Sort: earned first (most-recently unlocked at the top), then locked
  // in their natural definition order. Within earned, higher count breaks
  // ties so "century_day 14×" sits above a single-fire badge.
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
        {unlocked} of {list.length} unlocked · keep flying to discover more · tap any earned badge for detail
      </div>
      <div className="ach-grid">
        {sorted.map((a) => {
          const earned = a.count > 0;
          return (
            <button
              key={a.id}
              className={`ach${earned ? " earned" : ""}`}
              onClick={() => earned && setSelected(a)}
              type="button"
              aria-disabled={!earned}
            >
              <div className="ach-icon" aria-hidden="true">{earned ? a.icon : "🔒"}</div>
              <div className="ach-text">
                <div className="ach-title">{earned ? a.title : "???"}</div>
                <div className="ach-hint">{a.hint}</div>
              </div>
              {earned && a.count > 1 && (
                <div className="ach-count" title={`Achieved ${a.count} times`}>{a.count}×</div>
              )}
            </button>
          );
        })}
      </div>

      {selected && <AchievementDetail ach={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function AchievementDetail({ ach, onClose }: { ach: AchievementProgress; onClose: () => void }): JSX.Element {
  const first = ach.firstAt ? new Date(ach.firstAt) : null;
  const last = ach.lastAt ? new Date(ach.lastAt) : null;
  const sameTime = first && last && Math.abs(last.getTime() - first.getTime()) < 60_000;
  return (
    <div className="popout-backdrop" onClick={onClose}>
      <div className="ach-detail" onClick={(e) => e.stopPropagation()}>
        <button className="iconbtn ach-detail-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="ach-detail-icon">{ach.icon}</div>
        <div className="ach-detail-title">{ach.title ?? "Locked"}</div>
        <div className="ach-detail-body">
          {ach.description ?? ach.hint}
        </div>
        {ach.count > 1 && (
          <div className="ach-detail-count">Earned <strong>{ach.count}</strong> times</div>
        )}
        {first && (
          <div className="muted ach-detail-meta">
            First unlocked {fmtDate(first)}
            {last && !sameTime && <> · most recent {fmtDate(last)}</>}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtDate(d: Date): string {
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}
