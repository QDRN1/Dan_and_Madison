import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MlMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { useRadar, type Theme } from "../store";
import { altColor, altFeet } from "../format";

function makePlaneImage(): { data: Uint8ClampedArray; width: number; height: number } {
  const vb = 32;
  const scale = 4;
  const W = vb * scale;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = W;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  // Top-view airliner silhouette, nose pointing up (north).
  const p = new Path2D(
    "M16 1 C15 1 14 2 14 4 L14 11 L3 18 L3 21 L14 17 L14 25 L10 28 L10 30 L16 28 L22 30 L22 28 L18 25 L18 17 L29 21 L29 18 L18 11 L18 4 C18 2 17 1 16 1 Z",
  );
  ctx.fill(p);
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

export function MapView(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const readyRef = useRef(false);
  const handlersRef = useRef(false);
  const appliedThemeRef = useRef<Theme | null>(null);

  const config = useRadar((s) => s.config);
  const aircraft = useRadar((s) => s.aircraft);
  const selectedHex = useRadar((s) => s.selectedHex);
  const selectedTrail = useRadar((s) => s.selectedTrail);
  const select = useRadar((s) => s.select);
  const theme = useRadar((s) => s.theme);

  // Adds our sources + layers on top of whatever basemap style is loaded.
  // Idempotent: after a style switch the custom sources are gone, so we re-add.
  function installLayers(map: MlMap, t: Theme): void {
    if (!config) return;
    const { receiver } = config;
    const col = mapColors(t);

    if (!map.hasImage("plane")) map.addImage("plane", makePlaneImage(), { sdf: true, pixelRatio: 4 });

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
      map.addLayer({ id: "home-fill", type: "fill", source: "home-area", paint: { "fill-color": "#a3c940", "fill-opacity": 0.12 } });
    }
    if (!map.getLayer("home-line")) {
      map.addLayer({
        id: "home-line",
        type: "line",
        source: "home-area",
        paint: { "line-color": "#a3c940", "line-opacity": 0.55, "line-width": 1.5 },
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
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    map.on("load", () => {
      installLayers(map, useRadar.getState().theme);
      attachHandlers(map);
      readyRef.current = true;
      updateSource();
      updateTrail();
    });

    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
      handlersRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Switch basemap on theme change, then re-add our layers + data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !config) return;
    if (appliedThemeRef.current === theme) return;
    appliedThemeRef.current = theme;
    readyRef.current = false;
    map.setStyle(config.mapStyle[theme]);
    const onStyle = () => {
      if (!map.isStyleLoaded()) return;
      map.off("styledata", onStyle);
      installLayers(map, theme);
      readyRef.current = true;
      updateSource();
      updateTrail();
    };
    map.on("styledata", onStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, config]);

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
