import { useEffect, useState } from "react";
import { BASE, api, connectLive } from "./api";
import { useRadar } from "./store";
import { RadarView } from "./components/RadarView";
import { Splash } from "./components/Splash";
import { Setup } from "./pages/Setup";
import { Admin } from "./pages/Admin";

type Route = "radar" | "setup" | "admin";

function currentRoute(): Route {
  const path = location.pathname.replace(BASE, "").replace(/^\/+/, "");
  if (path.startsWith("setup")) return "setup";
  if (path.startsWith("admin")) return "admin";
  return "radar";
}

export function App(): JSX.Element {
  const setConfig = useRadar((s) => s.setConfig);
  const applySnapshot = useRadar((s) => s.applySnapshot);
  const config = useRadar((s) => s.config);
  const theme = useRadar((s) => s.theme);
  const [route, setRoute] = useState<Route>(currentRoute());

  // Cool radar splash on the main view: shows until config loads + a min time.
  const [minElapsed, setMinElapsed] = useState(false);
  const [splashGone, setSplashGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), 2200);
    return () => clearTimeout(t);
  }, []);
  const splashFading = Boolean(config) && minElapsed;
  useEffect(() => {
    if (!splashFading || splashGone) return;
    const t = setTimeout(() => setSplashGone(true), 650);
    return () => clearTimeout(t);
  }, [splashFading, splashGone]);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch(() => undefined);
  }, [setConfig]);

  // Live feed only matters for the radar view.
  useEffect(() => {
    if (route !== "radar") return;
    const disconnect = connectLive(applySnapshot);
    return disconnect;
  }, [route, applySnapshot]);

  // Apply + persist the light/dark theme globally.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("qdrn-theme", theme);
    } catch {
      /* ignore */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#001533" : "#eef1f6");
  }, [theme]);

  if (route === "setup") return <Setup />;
  if (route === "admin") return <Admin />;
  return (
    <>
      <RadarView />
      {!splashGone && <Splash fading={splashFading} />}
    </>
  );
}
