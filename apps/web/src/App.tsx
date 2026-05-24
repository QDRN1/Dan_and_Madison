import { useEffect, useState } from "react";
import { BASE, api, connectLive } from "./api";
import { useRadar } from "./store";
import { RadarView } from "./components/RadarView";
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
  const [route, setRoute] = useState<Route>(currentRoute());

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

  // Apply brand colors from server config as CSS variables (lets you re-skin
  // without rebuilding).
  useEffect(() => {
    if (!config) return;
    const c = config.brand.colors;
    const root = document.documentElement.style;
    root.setProperty("--bg", c.bg);
    root.setProperty("--surface", c.surface);
    root.setProperty("--accent", c.accent);
    root.setProperty("--accent-2", c.accent2);
    root.setProperty("--text", c.text);
    root.setProperty("--muted", c.muted);
  }, [config]);

  if (route === "setup") return <Setup />;
  if (route === "admin") return <Admin />;
  return <RadarView />;
}
