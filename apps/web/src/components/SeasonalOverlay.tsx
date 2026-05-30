import { useEffect, useState } from "react";
import { useRadar } from "../store";

/** Date/time-driven visual easter eggs — kept in one place so they're easy to
 *  reason about and disable. Currently:
 *   • New Year's Day (Jan 1, all day, user-local): gold firework spark rain.
 *   • Within ±1 hour of local sunrise OR sunset: warm gradient tint at the
 *     edges of the screen so the map "feels" the golden hour.
 *   • Halloween (Oct 31, after dusk): subtle purple vignette. */
export function SeasonalOverlay(): JSX.Element | null {
  const rx = useRadar((s) => s.config?.receiver);
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    // Re-evaluate every 5 min so we cross sunset/sunrise boundaries without a reload.
    const t = setInterval(() => setTick(Date.now()), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const now = new Date(tick);
  const isNewYear = now.getMonth() === 0 && now.getDate() === 1;
  const isHalloweenNight = now.getMonth() === 9 && now.getDate() === 31 && now.getHours() >= 17;

  let goldenHour: "sunrise" | "sunset" | null = null;
  if (rx) {
    const sun = sunTimes(now, rx.lat, rx.lon);
    if (sun) {
      const HOUR = 60 * 60 * 1000;
      const t = now.getTime();
      if (Math.abs(t - sun.sunrise) <= HOUR) goldenHour = "sunrise";
      else if (Math.abs(t - sun.sunset) <= HOUR) goldenHour = "sunset";
    }
  }

  if (!isNewYear && !isHalloweenNight && !goldenHour) return null;

  return (
    <>
      {goldenHour && <div className={`golden-tint ${goldenHour}`} aria-hidden="true" />}
      {isHalloweenNight && <div className="halloween-tint" aria-hidden="true" />}
      {isNewYear && <FireworkRain />}
    </>
  );
}

/** Lightweight DOM-only sparks. 40 spans with randomized delays/positions
 *  drifting downward — looks like falling firework embers without a canvas. */
function FireworkRain(): JSX.Element {
  const sparks = Array.from({ length: 40 }, (_, i) => i);
  return (
    <div className="fireworks" aria-hidden="true">
      {sparks.map((i) => {
        const left = Math.round(Math.random() * 100);
        const delay = (Math.random() * 6).toFixed(2);
        const dur = (4 + Math.random() * 4).toFixed(2);
        const hue = [40, 50, 12, 350, 200][i % 5];
        return (
          <span
            key={i}
            className="spark"
            style={{
              left: `${left}%`,
              animationDelay: `${delay}s`,
              animationDuration: `${dur}s`,
              background: `hsl(${hue}, 95%, 65%)`,
              boxShadow: `0 0 8px hsl(${hue}, 95%, 65%)`,
            }}
          />
        );
      })}
    </div>
  );
}

/** NOAA-style sunrise/sunset for the given date at lat/lon. Returns epoch ms
 *  for each, or null if the sun never rises/sets that day at this latitude. */
function sunTimes(date: Date, lat: number, lon: number): { sunrise: number; sunset: number } | null {
  // Days since J2000 (noon UT on Jan 1, 2000).
  const J1970 = 2440588;
  const J2000 = 2451545;
  const ms = date.setHours(0, 0, 0, 0);
  const j = ms / 86400000 - 0.5 + J1970 - J2000;

  const M = ((357.5291 + 0.98560028 * j) % 360) * Math.PI / 180;
  const C = (1.9148 * Math.sin(M) + 0.0200 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * Math.PI / 180;
  const L = M + C + (180 + 102.9372) * Math.PI / 180;
  const sinDec = Math.sin(L) * Math.sin(23.4397 * Math.PI / 180);
  const dec = Math.asin(sinDec);

  const latR = lat * Math.PI / 180;
  const cosH = (Math.sin(-0.83 * Math.PI / 180) - Math.sin(latR) * sinDec) / (Math.cos(latR) * Math.cos(dec));
  if (cosH > 1 || cosH < -1) return null;
  const H = Math.acos(cosH);

  // Solar noon (epoch ms) at this longitude.
  const Jtransit = 2451545 + (0.0009 + (-lon / 360 + (j - 0.0009 - -lon / 360))) + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const noonMs = (Jtransit - J1970 + 0.5) * 86400000;
  const halfDayMs = (H / (2 * Math.PI)) * 86400000;
  return { sunrise: noonMs - halfDayMs, sunset: noonMs + halfDayMs };
}
