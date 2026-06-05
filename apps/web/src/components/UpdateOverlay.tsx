import { useEffect, useState } from "react";
import { useRadar } from "../store";

/** Full-screen overlay shown while a "Pull update + restart" job runs.
 *  Lives at the root of RadarView (sibling of SightingsPopout) so it
 *  escapes the drawer's transform and covers the whole viewport. The
 *  actual update orchestration (calling /admin/update, polling
 *  device-info, deciding when to reload) lives in Settings.tsx — this
 *  is the presentational layer that turns store.updateJob into a big
 *  timer + status. */
export function UpdateOverlay(): JSX.Element | null {
  const job = useRadar((s) => s.updateJob);
  const setJob = useRadar((s) => s.setUpdateJob);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!job) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [job]);

  if (!job) return null;
  const elapsedMs = Math.max(0, now - job.startedAt);
  const mm = Math.floor(elapsedMs / 60000);
  const ss = Math.floor((elapsedMs % 60000) / 1000);
  const isError = Boolean(job.error);

  return (
    <div className="update-backdrop" role="alertdialog" aria-live="polite">
      <div className={`update-card${isError ? " error" : ""}`}>
        {!isError && (
          <>
            <div className="update-spinner" aria-hidden />
            <div className="update-title">Updating radar</div>
            <div className="update-clock" aria-label={`Elapsed ${mm} minutes ${ss} seconds`}>
              {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
            </div>
            <div className="update-phase">{job.phase}</div>
            <div className="update-hint muted">The page auto-refreshes when the new build is live.</div>
            <button
              className="btn"
              style={{ marginTop: 18, opacity: 0.7 }}
              onClick={() => setJob(null)}
              type="button"
            >
              Hide (update keeps running)
            </button>
          </>
        )}
        {isError && (
          <>
            <div className="update-title" style={{ color: "var(--danger)" }}>Update didn't complete</div>
            <div className="update-clock" style={{ color: "var(--danger)" }}>
              {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
            </div>
            <div className="update-phase" style={{ whiteSpace: "pre-wrap" }}>{job.error}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => window.location.reload()} type="button">
                Refresh page
              </button>
              <button className="btn" onClick={() => setJob(null)} type="button">
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
