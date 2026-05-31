import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MlMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { CoveragePoint } from "@qdrn/shared";
import { api } from "../api";
import { useRadar, type IconTheme, type Theme } from "../store";
import { altColor, altFeet } from "../format";

/** SVG paths for each plane-icon theme — all drawn in a 32x32 viewBox. They
 *  render as SDF so altitude color tints still apply. */
const ICON_PATHS: Record<IconTheme, string> = {
  // Classic airliner top-view.
  plane:
    "M16 1 C15 1 14 2 14 4 L14 11 L3 18 L3 21 L14 17 L14 25 L10 28 L10 30 L16 28 L22 30 L22 28 L18 25 L18 17 L29 21 L29 18 L18 11 L18 4 C18 2 17 1 16 1 Z",
  // Dog paw print (Madison's love).
  paw:
    "M16 16 C12 16 9 19 9 23 C9 26 12 29 16 29 C20 29 23 26 23 23 C23 19 20 16 16 16 Z " +
    "M7 13 C5 13 4 11 4 9 C4 7 5 5 7 5 C9 5 10 7 10 9 C10 11 9 13 7 13 Z " +
    "M25 13 C23 13 22 11 22 9 C22 7 23 5 25 5 C27 5 28 7 28 9 C28 11 27 13 25 13 Z " +
    "M12 9 C10 9 9 7 9 5 C9 3 10 1 12 1 C14 1 15 3 15 5 C15 7 14 9 12 9 Z " +
    "M20 9 C18 9 17 7 17 5 C17 3 18 1 20 1 C22 1 23 3 23 5 C23 7 22 9 20 9 Z",
  // Heart (the Hobbit House dwellers).
  heart:
    "M16 28 C16 28 4 20 4 11 C4 6 8 3 12 3 C14 3 15 4 16 6 C17 4 18 3 20 3 C24 3 28 6 28 11 C28 20 16 28 16 28 Z",
  // UFO — saucer with dome on top.
  ufo:
    "M16 6 C19 6 22 8 22 12 L23 13 L26 14 L28 16 L28 18 L4 18 L4 16 L6 14 L9 13 L10 12 C10 8 13 6 16 6 Z " +
    "M11 19 C12 21 14 22 16 22 C18 22 20 21 21 19 Z " +
    "M10 22 L9 25 M22 22 L23 25 M16 22 L16 26",
};

function makePlaneImage(kind: IconTheme = "plane"): { data: Uint8ClampedArray; width: number; height: number } {
  const vb = 32;
  const scale = 4;
  const W = vb * scale;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = W;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const p = new Path2D(ICON_PATHS[kind]);
  ctx.fill(p);
  // UFO has a couple of stroked beams — strokes contribute to SDF too.
  if (kind === "ufo") ctx.stroke(p);
  return { data: ctx.getImageData(0, 0, W, W).data, width: W, height: W };
}

function ringCoords(lon: number, lat: number, nm: number): [number, number][] {
  const R = 6371;
  const d = (nm * 1.852) / R;
  const latR = (lat * Math.PI) / 180;
  const lonR = (lon * Math.PI) / 180;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const brng = (i / 64) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(brng));
    const lon2 =
      lonR + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(latR), Math.cos(d) - Math.sin(latR) * Math.sin(lat2));
    pts.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return pts;
}

function mapColors(t: Theme): { label: string; halo: string; marker: string } {
  return t === "dark"
    ? { label: "#F0F0F0", halo: "#001533", marker: "#001533" }
    : { label: "#0b1b33", halo: "#ffffff", marker: "#ffffff" };
}

// Radius of the soft "home area" circle (km). Large enough to cover the city
// so the exact house isn't pinpointed.
const HOME_AREA_NM = 7 / 1.852;

function emptyFc(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function coveragePolygon(points: CoveragePoint[]): FeatureCollection {
  if (points.length < 3) return emptyFc();
  const ring = points.map((p) => [p.lon, p.lat] as [number, number]);
  ring.push(ring[0]!);
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
  };
}

export function MapView(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);
  const handlersRef = useRef(false);
  const appliedThemeRef = useRef<Theme | null>(null);
  const coverageRef = useRef<CoveragePoint[]>([]);

  const config = useRadar((s) => s.config);
  const aircraft = useRadar((s) => s.aircraft);
  const selectedHex = useRadar((s) => s.selectedHex);
  const selectedTrail = useRadar((s) => s.selectedTrail);
  const select = useRadar((s) => s.select);
  const theme = useRadar((s) => s.theme);
  const iconTheme = useRadar((s) => s.iconTheme);
  const stormOverlay = useRadar((s) => s.stormOverlay);

  // Adds our sources + layers on top of whatever basemap style is loaded.
  // Idempotent: after a style switch the custom sources are gone, so we re-add.
  function installLayers(map: MlMap, t: Theme, icon: IconTheme): void {
    if (!config) return;
    const { receiver } = config;
    const col = mapColors(t);

    // Re-create the plane icon every install: setStyle() drops style images, and
    // a stale hasImage() check can leave the symbol layer with no texture (planes
    // vanish after a dark/light switch). Recreate it fresh to be safe.
    if (map.hasImage("plane")) map.removeImage("plane");
    map.addImage("plane", makePlaneImage(icon), { sdf: true, pixelRatio: 4 });

    // Surface airport runways/taxiways earlier (the basemap hides them until
    // you zoom way in) and make runways bold enough to read at wide zoom so
    // major airports are recognizable as "airport-shaped" from out-of-state.
    for (const id of ["aeroway-runway", "aeroway-taxiway"]) {
      if (!map.getLayer(id)) continue;
      try {
        map.setLayerZoomRange(id, id === "aeroway-runway" ? 6 : 9, 24);
        map.setPaintProperty(id, "line-opacity", id === "aeroway-runway" ? 1 : 0.6);
        map.setPaintProperty(id, "line-width", [
          "interpolate",
          ["linear"],
          ["zoom"],
          6,  id === "aeroway-runway" ? 1.8 : 0.4,
          9,  id === "aeroway-runway" ? 3   : 0.6,
          12, id === "aeroway-runway" ? 5   : 1.5,
          14, id === "aeroway-runway" ? 7   : 2.5,
        ]);
        if (id === "aeroway-runway") map.setPaintProperty(id, "line-color", col.label);
      } catch {
        /* layer shape differs on this basemap — skip */
      }
    }

    // Coverage footprint: the farthest aircraft tracked per bearing.
    if (!map.getSource("coverage")) {
      map.addSource("coverage", { type: "geojson", data: coveragePolygon(coverageRef.current) });
    }
    if (!map.getLayer("coverage-fill")) {
      map.addLayer({ id: "coverage-fill", type: "fill", source: "coverage", paint: { "fill-color": "#5b8def", "fill-opacity": 0.06 } });
    }
    if (!map.getLayer("coverage-line")) {
      map.addLayer({
        id: "coverage-line",
        type: "line",
        source: "coverage",
        layout: { "line-join": "round" },
        paint: { "line-color": "#5b8def", "line-opacity": 0.55, "line-width": 1.5, "line-dasharray": [4, 2] },
      });
    }

    if (!map.getSource("rings")) {
      map.addSource("rings", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: receiver.rangeRingsNm.map((nm) => ({
            type: "Feature",
            properties: { nm },
            geometry: { type: "LineString", coordinates: ringCoords(receiver.lon, receiver.lat, nm) },
          })),
        },
      });
    }
    if (!map.getLayer("rings")) {
      map.addLayer({
        id: "rings",
        type: "line",
        source: "rings",
        paint: { "line-color": "#a3c940", "line-opacity": 0.3, "line-width": 1, "line-dasharray": [3, 3] },
      });
    }

    // Soft "home area" circle covering the city (not a pinpoint of the house).
    if (!map.getSource("home-area")) {
      map.addSource("home-area", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [ringCoords(receiver.lon, receiver.lat, HOME_AREA_NM)] },
        },
      });
    }
    if (!map.getLayer("home-fill")) {
      map.addLayer({ id: "home-fill", type: "fill", source: "home-area", paint: { "fill-color": "#a3c940", "fill-opacity": 0.05 } });
    }
    if (!map.getLayer("home-line")) {
      map.addLayer({
        id: "home-line",
        type: "line",
        source: "home-area",
        paint: { "line-color": "#a3c940", "line-opacity": 0.25, "line-width": 1 },
      });
    }

    // City label at the center so "Minneapolis" is clearly shown.
    if (!map.getSource("home-point")) {
      map.addSource("home-point", { type: "geojson", data: { type: "Point", coordinates: [receiver.lon, receiver.lat] } });
    }
    if (!map.getLayer("home-label")) {
      map.addLayer({
        id: "home-label",
        type: "symbol",
        source: "home-point",
        layout: {
          "text-field": (config.receiver.city || "").split(",")[0] || "Home",
          "text-size": 17,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold", "Noto Sans Bold"],
          "text-allow-overlap": true,
          "text-letter-spacing": 0.04,
        },
        paint: { "text-color": col.label, "text-halo-color": col.halo, "text-halo-width": 2 },
      });
    }

    if (!map.getSource("trail")) map.addSource("trail", { type: "geojson", data: emptyFc() });
    if (!map.getLayer("trail-glow")) {
      map.addLayer({
        id: "trail-glow",
        type: "line",
        source: "trail",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#a3c940", "line-width": 7, "line-opacity": 0.18, "line-blur": 4 },
      });
    }
    if (!map.getLayer("trail")) {
      map.addLayer({
        id: "trail",
        type: "line",
        source: "trail",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2.6, "line-opacity": 0.9 },
      });
    }

    if (!map.getSource("aircraft")) map.addSource("aircraft", { type: "geojson", data: emptyFc() });
    if (!map.getLayer("ac-highlight")) {
      map.addLayer({
        id: "ac-highlight",
        type: "circle",
        source: "aircraft",
        filter: ["==", ["get", "selected"], 1],
        paint: {
          "circle-radius": 16,
          "circle-color": "rgba(163,201,64,0.22)",
          "circle-stroke-color": "#a3c940",
          "circle-stroke-width": 2,
        },
      });
    }
    if (!map.getLayer("ac-plane")) {
      map.addLayer({
        id: "ac-plane",
        type: "symbol",
        source: "aircraft",
        layout: {
          "icon-image": "plane",
          "icon-size": 0.7,
          "icon-rotate": ["get", "track"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-color": ["get", "color"] },
      });
    }
    if (!map.getLayer("ac-label")) {
      map.addLayer({
        id: "ac-label",
        type: "symbol",
        minzoom: 8.5,
        source: "aircraft",
        layout: {
          "text-field": ["get", "flight"],
          "text-size": 11,
          "text-offset": [0, 1.3],
          "text-anchor": "top",
          "text-optional": true,
          "text-allow-overlap": false,
        },
        paint: { "text-color": col.label, "text-halo-color": col.halo, "text-halo-width": 1.3 },
      });
    }
  }

  function attachHandlers(map: MlMap): void {
    if (handlersRef.current) return;
    handlersRef.current = true;
    map.on("click", "ac-plane", (e) => {
      const hex = e.features?.[0]?.properties?.hex as string | undefined;
      if (hex) select(hex);
    });
    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ["ac-plane"] });
      if (hits.length === 0) select(null);
    });
    for (const layer of ["ac-plane", "ac-highlight"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
  }

  function updateSource(): void {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource("aircraft") as GeoJSONSource | undefined;
    if (!src) return;
    const cur = useRadar.getState();
    src.setData({
      type: "FeatureCollection",
      features: cur.aircraft
        .filter((a) => a.lon != null && a.lat != null)
        .map((a) => ({
          type: "Feature",
          properties: {
            hex: a.hex,
            flight: a.flight?.trim() ?? "",
            track: a.track ?? 0,
            color: altColor(altFeet(a)),
            selected: a.hex === cur.selectedHex ? 1 : 0,
          },
          geometry: { type: "Point", coordinates: [a.lon!, a.lat!] },
        })),
    });
  }

  function updateCoverage(): void {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource("coverage") as GeoJSONSource | undefined;
    if (src) src.setData(coveragePolygon(coverageRef.current));
  }

  function updateTrail(): void {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource("trail") as GeoJSONSource | undefined;
    if (!src) return;
    const pts = useRadar.getState().selectedTrail ?? [];
    const features: FeatureCollection["features"] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      features.push({
        type: "Feature",
        properties: { color: altColor(b.alt) },
        geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
      });
    }
    src.setData({ type: "FeatureCollection", features });
  }

  // Create the map once config is available.
  useEffect(() => {
    if (!config || mapRef.current || !containerRef.current) return;
    const { receiver } = config;
    const t = useRadar.getState().theme;
    appliedThemeRef.current = t;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: config.mapStyle[t],
      center: [receiver.lon, receiver.lat],
      zoom: 8,
      attributionControl: { compact: true },
    });
    // Compass/pitch button removed — rotation is disabled, so it did nothing.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    map.on("load", () => {
      const st = useRadar.getState();
      installLayers(map, st.theme, st.iconTheme);
      attachHandlers(map);
      readyRef.current = true;
      updateSource();
      updateTrail();
      updateCoverage();
    });

    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
      handlersRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Switch basemap on theme change, then re-add our layers + data. We wait for
  // the map to go idle (new style fully loaded) before re-installing — using the
  // early "styledata" events races the style swap and leaves layers/planes
  // wiped. Re-installing on idle also restores the coverage outline + rings.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !config) return;
    if (appliedThemeRef.current === theme) return;
    appliedThemeRef.current = theme;
    readyRef.current = false;
    map.setStyle(config.mapStyle[theme]);
    const reinstall = () => {
      installLayers(map, theme, useRadar.getState().iconTheme);
      readyRef.current = true;
      updateSource();
      updateTrail();
      updateCoverage();
    };
    map.once("idle", reinstall);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, config]);

  // Swap the plane glyph in-place when the user picks a new icon theme. No
  // basemap reload — just replace the SDF image and the symbol layer repaints.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (map.hasImage("plane")) map.removeImage("plane");
    map.addImage("plane", makePlaneImage(iconTheme), { sdf: true, pixelRatio: 4 });
    // Trigger a repaint of the symbol layer.
    updateSource();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iconTheme]);

  // Storm radar overlay (RainViewer). RainViewer serves a literal
  // "Zoom Level Not Supported" placeholder PNG above their tile cap, which
  // bled through earlier opacity fades. Hard-cut the layer at z9 (above
  // metro zoom it just vanishes), and cap the source at z7 so MapLibre
  // doesn't even request the bad tiles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    const removeLayer = () => {
      if (map.getLayer("storm")) map.removeLayer("storm");
      if (map.getSource("storm")) map.removeSource("storm");
    };

    if (!stormOverlay) { removeLayer(); return; }

    let alive = true;
    const apply = async () => {
      try {
        const r = await fetch("https://api.rainviewer.com/public/weather-maps.json");
        if (!r.ok) return;
        const j = (await r.json()) as { radar?: { past?: { time: number; path: string }[] } };
        const last = j.radar?.past?.at(-1);
        if (!alive || !last) return;
        removeLayer();
        map.addSource("storm", {
          type: "raster",
          tiles: [`https://tilecache.rainviewer.com${last.path}/256/{z}/{x}/{y}/2/1_1.png`],
          tileSize: 256,
          maxzoom: 7,
          attribution: "Radar © RainViewer",
        });
        const before = map.getLayer("ac-highlight") ? "ac-highlight" : undefined;
        map.addLayer({
          id: "storm",
          type: "raster",
          source: "storm",
          maxzoom: 9,
          paint: { "raster-opacity": 0.55 },
        }, before);
      } catch { /* offline / blocked — silently skip */ }
    };
    void apply();
    const t = setInterval(() => void apply(), 10 * 60 * 1000);
    return () => { alive = false; clearInterval(t); removeLayer(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stormOverlay, theme]);

  // Push live aircraft / selection to the map.
  useEffect(() => {
    updateSource();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aircraft, selectedHex]);

  // Draw the selected aircraft's trail.
  useEffect(() => {
    updateTrail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrail]);

  // Periodically refresh the coverage footprint (grows slowly over time).
  useEffect(() => {
    if (!config) return;
    let alive = true;
    const load = () =>
      api
        .coverage()
        .then((pts) => {
          if (!alive) return;
          coverageRef.current = pts;
          updateCoverage();
        })
        .catch(() => undefined);
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Gently pan to a newly selected aircraft.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedHex) return;
    const a = aircraft.find((x) => x.hex === selectedHex);
    if (a?.lon != null && a?.lat != null) map.easeTo({ center: [a.lon, a.lat], duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHex]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
