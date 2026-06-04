import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MlMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { CoveragePoint } from "@qdrn/shared";
import { api } from "../api";
import { useRadar, type IconTheme, type Theme } from "../store";
import { altColor, altFeet } from "../format";
import { MAJOR_AIRPORTS } from "./major-airports";

/** SVG paths for each plane-icon theme — drawn in a 64x64 viewBox so the
 *  curves keep their fidelity once the SDF resamples. They render with a
 *  single fill (no separate stroke ops) so the altitude color tint covers
 *  the whole shape cleanly. */
const ICON_PATHS: Record<IconTheme, string> = {
  // Top-view airliner: nose up (north), tapered fuselage, swept wings,
  // forward-swept horizontal stab. Less blocky than the old version.
  plane:
    "M32 4 C29 4 27.5 6 27.5 9 L27.5 22 L4 36 L4 40 L27.5 33 L27.5 47 L19 53 L19 56 L32 53 L45 56 L45 53 L36.5 47 L36.5 33 L60 40 L60 36 L36.5 22 L36.5 9 C36.5 6 35 4 32 4 Z",
  // Paw print — central pad + four rounded toes. Cleaner geometry with
  // proper ellipses so the toes don't look like blobs.
  paw:
    "M32 30 C25 30 19 36 19 44 C19 51 25 56 32 56 C39 56 45 51 45 44 C45 36 39 30 32 30 Z " +
    "M13 25 C9 25 6 21 6 16 C6 11 9 7 13 7 C17 7 20 11 20 16 C20 21 17 25 13 25 Z " +
    "M51 25 C47 25 44 21 44 16 C44 11 47 7 51 7 C55 7 58 11 58 16 C58 21 55 25 51 25 Z " +
    "M23 18 C20 18 17 15 17 11 C17 7 20 4 23 4 C26 4 29 7 29 11 C29 15 26 18 23 18 Z " +
    "M41 18 C38 18 35 15 35 11 C35 7 38 4 41 4 C44 4 47 7 47 11 C47 15 44 18 41 18 Z",
  // Heart — classic symmetric cardioid. Higher control points so the lobes
  // are rounder and the point is sharper.
  heart:
    "M32 58 C28 54 8 42 8 23 C8 14 14 8 21 8 C25 8 29 10 32 14 C35 10 39 8 43 8 C50 8 56 14 56 23 C56 42 36 54 32 58 Z",
  // UFO — flying saucer in profile: rounded dome, wide disc bulge, no
  // separate beam (kept the silhouette readable at small sizes). Drawn as
  // one closed path so the SDF fills cleanly.
  ufo:
    "M32 10 C24 10 18 14 18 21 L18 24 L10 26 C4 27 1 30 1 33 C1 36 6 38 14 39 C20 40 27 41 32 41 C37 41 44 40 50 39 C58 38 63 36 63 33 C63 30 60 27 54 26 L46 24 L46 21 C46 14 40 10 32 10 Z " +
    "M28 16 C27 16 26 17 26 18 C26 19 27 20 28 20 C29 20 30 19 30 18 C30 17 29 16 28 16 Z " +
    "M36 16 C35 16 34 17 34 18 C34 19 35 20 36 20 C37 20 38 19 38 18 C38 17 37 16 36 16 Z",
};

/** Helicopter silhouette. Rendered as its own image (not part of the
 *  plane-theme rotation) so a B407 always reads as a helicopter even when
 *  the user has paws / hearts / UFOs selected for fixed-wing. Top-view
 *  body + tail boom + tail rotor + crossed main rotor bars, single fill. */
const HELICOPTER_PATH =
  "M 32 14 C 26 14 22 18 22 24 L 22 36 C 22 40 26 42 32 42 C 38 42 42 40 42 36 L 42 24 C 42 18 38 14 32 14 Z " +
  "M 31 42 L 33 42 L 33 56 L 31 56 Z " +
  "M 27 55 L 37 55 L 37 60 L 27 60 Z " +
  "M 6 28 L 58 28 L 58 32 L 6 32 Z " +
  "M 30 4 L 34 4 L 34 26 L 30 26 Z " +
  "M 30 34 L 34 34 L 34 58 L 30 58 Z";

function makeIconImage(path: string): { data: Uint8ClampedArray; width: number; height: number } {
  const vb = 64;
  const scale = 4;
  const W = vb * scale;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = W;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.fill(new Path2D(path));
  return { data: ctx.getImageData(0, 0, W, W).data, width: W, height: W };
}

function makePlaneImage(kind: IconTheme = "plane"): { data: Uint8ClampedArray; width: number; height: number } {
  return makeIconImage(ICON_PATHS[kind]);
}

function makeHelicopterImage(): { data: Uint8ClampedArray; width: number; height: number } {
  return makeIconImage(HELICOPTER_PATH);
}

/** ADS-B emitter category A7 is rotorcraft (helicopters). Also fall back
 *  to a type-code regex covering the major civil + military helicopters
 *  so a plane without category info still reads correctly. */
function isHelicopter(category?: string, typeCode?: string): boolean {
  if (category === "A7") return true;
  if (!typeCode) return false;
  return /\b(R22|R44|R66|EC[0-9]|H1[35]5|H125|H145|H160|H175|UH-?60|AS3[0-9]|AS65|AS50|AS55|S70|S76|S92|EC1|B407|B412|B429|B505|A109|A119|A139|MD500|MD600|MD9|R[0-9]|HEL|UH-|CH-|MI-?[0-9]|KA[0-9])\b/i.test(typeCode);
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
    if (map.hasImage("helicopter")) map.removeImage("helicopter");
    map.addImage("helicopter", makeHelicopterImage(), { sdf: true, pixelRatio: 4 });

    // Surface airport runways much further out (from z4, country-scale) and
    // hammer the contrast so major airports are visible without zooming in.
    // The runway color is hardcoded — relying on theme variables left them
    // washed out on the light basemap. A wider accent-green casing layer
    // rides underneath at wide zoom to act as a "glow" so airports pop out
    // of the basemap; it fades out once the runway itself is thick enough
    // to stand on its own.
    const runwayColor = t === "dark" ? "#f3f6fb" : "#001533";
    const glowColor = "#A3C940";

    // Glow casing. Inserted before the existing runway layer so it renders
    // beneath. Same source/source-layer; runway lookup tells us which to use.
    const runwayLayer = map.getLayer("aeroway-runway") as { source?: string; "source-layer"?: string } | undefined;
    if (runwayLayer?.source) {
      if (map.getLayer("runway-glow")) map.removeLayer("runway-glow");
      map.addLayer({
        id: "runway-glow",
        type: "line",
        source: runwayLayer.source,
        "source-layer": runwayLayer["source-layer"] ?? "aeroway",
        filter: ["==", ["get", "class"], "runway"],
        minzoom: 4,
        maxzoom: 11,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": glowColor,
          "line-blur": 2,
          "line-opacity": [
            "interpolate", ["linear"], ["zoom"],
            4, 0.85,
            8, 0.5,
            11, 0,
          ],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            4, 4,
            6, 6,
            9, 9,
            11, 11,
          ],
        },
      }, "aeroway-runway");
    }

    for (const id of ["aeroway-runway", "aeroway-taxiway"]) {
      if (!map.getLayer(id)) continue;
      try {
        map.setLayerZoomRange(id, id === "aeroway-runway" ? 4 : 9, 24);
        map.setPaintProperty(id, "line-opacity", id === "aeroway-runway" ? 1 : 0.6);
        map.setPaintProperty(id, "line-width", [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,  id === "aeroway-runway" ? 2   : 0.3,
          6,  id === "aeroway-runway" ? 2.8 : 0.4,
          9,  id === "aeroway-runway" ? 4   : 0.7,
          12, id === "aeroway-runway" ? 6   : 1.6,
          14, id === "aeroway-runway" ? 8   : 2.6,
        ]);
        if (id === "aeroway-runway") map.setPaintProperty(id, "line-color", runwayColor);
      } catch {
        /* layer shape differs on this basemap — skip */
      }
    }

    // Static major-airports layer for wide zoom. OpenMapTiles aeroway data
    // doesn't exist below ~z11, so country/regional views were empty of any
    // airport markers. We bundle ~150 hubs and render them as a circle +
    // IATA label from z2; both fade out by z10 where the real runway
    // geometry takes over.
    if (!map.getSource("major-airports")) {
      map.addSource("major-airports", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: MAJOR_AIRPORTS.map(([iata, icao, lat, lon, name]) => ({
            type: "Feature" as const,
            properties: { iata, icao, name },
            geometry: { type: "Point" as const, coordinates: [lon, lat] },
          })),
        },
      });
    }
    if (!map.getLayer("major-airport-dot")) {
      map.addLayer({
        id: "major-airport-dot",
        type: "circle",
        source: "major-airports",
        minzoom: 2,
        maxzoom: 10,
        paint: {
          "circle-color": "#A3C940",
          "circle-stroke-color": runwayColor,
          "circle-stroke-width": 1.2,
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            2, 2,
            5, 3.5,
            8, 5,
            10, 7,
          ],
          "circle-opacity": [
            "interpolate", ["linear"], ["zoom"],
            2, 0.95,
            8, 0.9,
            10, 0,
          ],
        },
      });
    }
    if (!map.getLayer("major-airport-label")) {
      map.addLayer({
        id: "major-airport-label",
        type: "symbol",
        source: "major-airports",
        minzoom: 4,
        maxzoom: 10,
        layout: {
          "text-field": ["get", "iata"],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold", "Noto Sans Bold"],
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            4, 9,
            7, 11,
            10, 13,
          ],
          "text-offset": [0, 1],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": runwayColor,
          "text-halo-color": col.halo,
          "text-halo-width": 1.4,
          "text-opacity": [
            "interpolate", ["linear"], ["zoom"],
            4, 0,
            5, 0.9,
            9, 0.9,
            10, 0,
          ],
        },
      });
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
          // Per-feature icon: each row carries "plane" or "helicopter" in
          // its `icon` property so a B407 / EC135 / UH-60 reads as a heli
          // regardless of the user's plane theme.
          "icon-image": ["get", "icon"],
          "icon-size": 0.7,
          "icon-rotate": ["get", "track"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-color": ["get", "color"],
          // Off-radar planes from adsb.lol render at 45% so it's obvious
          // they're fill-in rather than receiver-tracked.
          "icon-opacity": ["case", ["==", ["get", "offRadar"], 1], 0.45, 1],
        },
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
            // Picks the helicopter SDF when this airframe is a rotorcraft;
            // otherwise the user's plane-theme image. Helicopters don't
            // rotate around the heading the same way (rotor disc is the
            // top view) but rotating the icon still gives a directional cue.
            icon: isHelicopter(a.category, a.enrichment?.typeCode) ? "helicopter" : "plane",
            // 1 when the plane is fill-in from adsb.lol, 0 for local radar.
            // The ac-plane layer reads this to dim off-radar icons.
            offRadar: a.source === "adsblol" ? 1 : 0,
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
    // Re-center button: snaps the map back to receiver coords at the default
    // area zoom. Sits with the zoom controls in the bottom-right cluster.
    map.addControl(new RecenterControl(() => {
      const cfg = useRadar.getState().config;
      if (!cfg) return;
      map.easeTo({ center: [cfg.receiver.lon, cfg.receiver.lat], zoom: 8, duration: 700 });
    }), "bottom-right");
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

    // Auto-zoom out to the standard area view (z8) when the user enables
    // storm radar at a closer zoom — RainViewer tiles only render to z9,
    // and the rain pattern is meaningful at metro+ scale anyway.
    if (map.getZoom() > 8.2) {
      map.easeTo({ zoom: 8, duration: 600 });
    }

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

/** Custom MapLibre control that snaps the map back to the receiver center
 *  at the standard area zoom. Renders inline with the zoom +/- buttons. */
class RecenterControl {
  private container: HTMLDivElement | null = null;
  constructor(private onClick: () => void) {}
  onAdd(): HTMLDivElement {
    const c = document.createElement("div");
    c.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Re-center on receiver";
    btn.setAttribute("aria-label", "Re-center on receiver");
    btn.style.fontSize = "16px";
    btn.style.lineHeight = "1";
    btn.textContent = "⌖";
    btn.onclick = this.onClick;
    c.appendChild(btn);
    this.container = c;
    return c;
  }
  onRemove(): void {
    this.container?.parentNode?.removeChild(this.container);
    this.container = null;
  }
}
