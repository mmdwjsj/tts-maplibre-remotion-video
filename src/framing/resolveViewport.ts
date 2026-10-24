/**
 * Data-driven static framing for the province map.
 *
 * The map is rendered with d3-geo (`geoMercator` + SVG paths) — there is no
 * MapLibre/Mapbox dependency in this project — so framing is built on d3's own
 * `fitExtent`, which is the projected-bounds equivalent of MapLibre `fitBounds`:
 * it measures the *real projected polygon boundaries*, never a linear lon/lat
 * approximation and never centroid averages.
 *
 * The module is intentionally self-contained (no relative imports) so it can be
 * unit-tested straight from Node — including type stripping, which is how
 * `scripts/framing/viewport.test.mjs` and the dev server load it.
 *
 * Everything here is pure and deterministic: the same geography, the same
 * ranking ids and the same options always produce the same viewport. Nothing is
 * persisted, so two consecutive videos never share a framing result.
 */

import {geoBounds, geoMercator, geoPath} from 'd3-geo';
import type {GeoPermissibleObjects, GeoProjection} from 'd3-geo';
import type {Geometry} from 'geojson';

/* -------------------------------------------------------------------------- *
 * Stage geometry
 * -------------------------------------------------------------------------- */

export type FramingStage = {width: number; height: number};
export type FramingRect = {x0: number; y0: number; x1: number; y1: number};

/**
 * The map is authored in the *whole* portrait design canvas (1080 x 1920) and
 * drawn as a full-bleed bottom layer: the title header and the footer float on
 * top of it instead of carving out room next to it. Framing always uses exactly
 * these numbers, so the preview, the render and the layout can never disagree.
 */
export const MAP_STAGE: FramingStage = {width: 1080, height: 1920};

/**
 * Screen bands the title header (top) and the footer (bottom) occupy. Both are
 * doubly meaningful: they are the floor/ceiling the *map itself* respects, and
 * they keep floating rank labels clear of the overlays. The render paints a
 * gradient scrim over both bands for the same reason.
 *
 * `bottom` is deliberately generous: on a phone the caption and the app's own
 * controls sit over the lower part of the frame and would bury a province or a
 * rank label sitting there.
 */
export const MAP_OVERLAY_BANDS = {top: 250, bottom: 200};

/**
 * Fit-rect insets. The map is full-bleed horizontally but stops at both overlay
 * bands vertically: the title is large and dark, and the bottom of a phone
 * screen carries the caption bar — neither may cover a ranked province. The left
 * and right edges stay flush with the canvas.
 */
export const MAP_SAFE_INSET = {
  top: MAP_OVERLAY_BANDS.top,
  right: 24,
  bottom: MAP_OVERLAY_BANDS.bottom,
  left: 24,
};

/** The unobstructed band of the stage: floating labels are clamped into it. */
export const labelRectFor = (stage: FramingStage): FramingRect => ({
  x0: 0,
  y0: MAP_OVERLAY_BANDS.top,
  x1: stage.width,
  y1: Math.max(MAP_OVERLAY_BANDS.top, stage.height - MAP_OVERLAY_BANDS.bottom),
});

/**
 * Platform UI safe area, already resolved by `src/safearea/safeArea.ts`.
 *
 * It is passed in as **plain rectangles** on purpose: this module stays
 * dependency-free (Node can execute it directly, and the dev server, the
 * preview and the render all load the same file), and the safe-area module owns
 * every rule about margins, description tiers and the interactive keep-out.
 *
 * - `mapRect`   the area the *base map* is fitted into. The base map may run to
 *               the canvas edge horizontally, but it stops above the platform's
 *               bottom caption/description area so a ranked province is never
 *               buried under it.
 * - `labelRect` the area floating labels may occupy. Titles, rank numbers,
 *               province names and legend text all live inside it, away from
 *               the status bar, the right-hand action rail and the caption.
 */
export type FramingSafeArea = {
  /**
   * The rect the ranked provinces must be **fully** fitted into. This is the
   * platform's core content area (`coreRect`), not the bleed rect: a province
   * whose shape leaks under the status bar or the caption is not "visible".
   *
   * When omitted, `mapRect` is used (the old behaviour, which let the base map
   * bleed into the reserved bands).
   */
  fitRect?: FramingRect;
  mapRect?: FramingRect;
  labelRect?: FramingRect;
  /**
   * The platform's right-hand action rail (avatar / like / comment / share),
   * already widened by the configured content gap. Floating rank labels are
   * pushed out of it; the base map itself may extend into it.
   */
  keepOutRect?: FramingRect | null;
  /** Safe-area diagnostics merged into `viewport.warnings`. */
  warnings?: string[];
};

const MIN_RECT_SIZE = 80;
const WEB_MERCATOR_TILE_SIZE = 256;
const DEFAULT_CENTER: [number, number] = [100.5, 15];
/** How much of the country's lon span must be visible before re-centring it. */
const COUNTRY_CENTER_TOLERANCE = 0.95;

/* -------------------------------------------------------------------------- *
 * Options
 * -------------------------------------------------------------------------- */

export type FitMode = 'full-country' | 'data-driven' | 'manual';
export type FramingPreset = 'tight' | 'balanced' | 'wide';

/** Raw, user supplied configuration (JSON body, project file, ...). */
export type FramingOptions = {
  fitMode?: FitMode;
  framingPreset?: FramingPreset;
  /** Fraction of ranking entries that must stay inside the frame (count based). */
  coverageThreshold?: number;
  /**
   * Explicit opt-in for dropping ranked provinces. While `false` (the default)
   * `coverageThreshold` is forced to 1 — every ranked province stays visible, so
   * an old client that still posts `0.9` can never hide a province by accident.
   */
  allowOutlierDrop?: boolean;
  /** Extra inset ratio applied to the fit rect, 0 - 0.3. */
  padding?: number;
  /**
   * Vertical squash, 0 - 0.25. `0` keeps true proportions.
   *
   * Thailand is very tall and narrow, so fitting it into a 9:16 safe area
   * without distortion leaves a map that is only ~650px wide inside an 804px
   * box — a third of the frame turns into empty water. Squeezing the map
   * *vertically only* by 12% widens it by ~11% at the same height, and by 19%
   * the map fills the safe area's width exactly.
   *
   * This is safe here because the picture encodes rank with colour, not area or
   * distance: nothing on screen is measured against the map's proportions, and
   * there is no graticule, scale bar or true-circle decoration that would give
   * the distortion away. Text, label panels and leader-line weights are **never**
   * squashed — only the projected geography.
   */
  verticalSquash?: number;
  /**
   * Context floor: the smallest share of the country's longitude span the frame
   * is allowed to show, as a fraction (`0` disables it, preset default when
   * omitted). See `PRESET_RULES.contextFloor`.
   */
  contextFloor?: number;
  minZoom?: number;
  maxZoom?: number;
  /**
   * Intro camera move: open on the whole country and fly into the resolved
   * framing across the opening line. `false` freezes the camera on the resolved
   * framing from frame 0 (the pre-move behaviour).
   */
  cameraMove?: boolean;
  /** When true, a coverage shortfall is reported as a loud warning. */
  strictCoverage?: boolean;
  manualCenter?: [number, number];
  manualZoom?: number;
};

export type ResolvedFramingOptions = {
  fitMode: FitMode;
  framingPreset: FramingPreset;
  coverageThreshold: number;
  padding: number;
  /** Resolved vertical squash (0 = true proportions). */
  verticalSquash: number;
  /** Resolved context floor (fraction of the country lon span, 0 = off). */
  contextFloor: number;
  minZoom: number;
  maxZoom: number;
  /** Resolved intro camera move switch. */
  cameraMove: boolean;
  /** Resolved opt-in for dropping ranked provinces (default: never drop). */
  allowOutlierDrop: boolean;
  strictCoverage: boolean;
  manualCenter?: [number, number];
  manualZoom?: number;
};

export const DEFAULT_FRAMING_OPTIONS: ResolvedFramingOptions = {
  fitMode: 'data-driven',
  framingPreset: 'balanced',
  // 1 = every ranked province must be visible. Outlier dropping is opt-in only:
  // lowering this below 1 lets the camera trade one far-away province for zoom.
  coverageThreshold: 1,
  allowOutlierDrop: false,
  padding: -1,
  verticalSquash: 0.12,
  contextFloor: -1,
  minZoom: 5,
  maxZoom: 12,
  cameraMove: true,
  strictCoverage: false,
};

/**
 * Per preset behaviour. `padding`/`contextFloor: -1` mean "use the preset default".
 *
 * `contextFloor` exists because `contain` fitting alone has one blind spot: when
 * every ranked region sits on a north-south line, the frame is filled by a
 * narrow strip and the camera zooms until only a sliver of the country is left
 * — white land on white land, with no coastline or border to place it. The floor
 * keeps a minimum horizontal context by stepping the camera back just enough.
 * It is deliberately low for `tight` (hug the ranked regions first) and only
 * engages when the frame would otherwise show less than that share.
 */
const PRESET_RULES: Record<
  FramingPreset,
  {
    padding: number;
    minZoomGain: number;
    coverageFactor: number;
    coverageBonus: number;
    contextFloor: number;
  }
> = {
  // Presets differ in padding / context floor only. `coverageFactor` and
  // `coverageBonus` are kept at 1 / 0 on purpose: no preset silently drops a
  // ranked province. Dropping only happens when `coverageThreshold` is set
  // below 1 explicitly, which the UI exposes as a separate choice.
  //
  // Zoom in hard: when dropping is enabled, a tiny zoom gain is enough.
  tight: {padding: 0.02, minZoomGain: 1.03, coverageFactor: 1, coverageBonus: 0, contextFloor: 0.22},
  // Balance coverage and readability.
  balanced: {padding: 0.06, minZoomGain: 1.1, coverageFactor: 1, coverageBonus: 0, contextFloor: 0.3},
  // Show more geography: only drop a region when it unlocks a big zoom gain.
  wide: {padding: 0.1, minZoomGain: 1.35, coverageFactor: 1, coverageBonus: 0, contextFloor: 0.45},
};

/* -------------------------------------------------------------------------- *
 * Public helpers
 * -------------------------------------------------------------------------- */

/** Web-Mercator zoom equivalent of a d3 scale (world width = 2π·scale). */
export const scaleToZoom = (scale: number): number =>
  Math.log2((Math.max(scale, 1e-6) * 2 * Math.PI) / WEB_MERCATOR_TILE_SIZE);

export const zoomToScale = (zoom: number): number =>
  (WEB_MERCATOR_TILE_SIZE * Math.pow(2, zoom)) / (2 * Math.PI);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const normalizeId = (value: unknown): string =>
  String(value ?? '').trim().toUpperCase();

/** Longitude bounds of a GeoJSON collection, in degrees (null when unmeasurable). */
const countryLonBounds = (geojson: FramingGeoJson): {west: number; east: number} | null => {
  try {
    const [[west], [east]] = geoBounds(geojson as unknown as GeoPermissibleObjects);
    if (!Number.isFinite(west) || !Number.isFinite(east)) return null;
    const span = east - west;
    return span > 0 && span <= 360 ? {west, east} : null;
  } catch {
    return null;
  }
};

/** Longitude span the frame currently shows, measured on the projection itself. */
const visibleLonSpanOf = (
  projection: GeoProjection,
  stage: FramingStage,
  rect: FramingRect,
): number => {
  const midY = (rect.y0 + rect.y1) / 2;
  const left = projection.invert?.([0, midY]) ?? null;
  const right = projection.invert?.([stage.width, midY]) ?? null;
  if (!left || !right) return 0;
  const span = right[0] - left[0];
  return Number.isFinite(span) && span > 0 ? span : 0;
};

/**
 * Rescales a projection while keeping the geography under `pivot` exactly where
 * it is on screen. Calling `scale()` alone rescales around the projection's
 * translate origin, which slides the framed area off centre; re-anchoring on the
 * pivot is the cheap fix and needs no `center()` juggling.
 */
const rescaleKeepingPivot = (
  projection: GeoProjection,
  scale: number,
  pivot: [number, number],
): GeoProjection => {
  const anchor = projection.invert?.(pivot) ?? null;
  const centerPoint: [number, number] =
    anchor && Number.isFinite(anchor[0]) && Number.isFinite(anchor[1])
      ? [anchor[0], anchor[1]]
      : [DEFAULT_CENTER[0], DEFAULT_CENTER[1]];
  const origin = geoMercator().scale(scale).translate([0, 0]);
  const projected = origin(centerPoint) ?? [0, 0];
  return geoMercator()
    .scale(scale)
    .translate([pivot[0] - projected[0], pivot[1] - projected[1]]);
};

/**
 * Slides the map horizontally so the country's midpoint sits on the **centre of
 * the fit rect**, i.e. the empty water left and right of the landmass is split
 * evenly inside the area the platform leaves free.
 *
 * The target is the *rect* centre, not the canvas centre: once a safe area is in
 * play those two differ (the right-hand action rail pushes the core area left of
 * the canvas midline), and aligning to the canvas would offset the whole country
 * by that difference — enough to push an eastern province out of the frame.
 *
 * `boundsInFrame` is the union of the ranked provinces' projected boxes in the
 * current projection. When supplied, the shift is clamped so the move can never
 * push a ranked province out of `rect` — the country re-centres as far as it is
 * allowed to, and no further.
 *
 * `x = translate[0] + scale * λ` in d3-geo's Mercator, so moving the geography
 * by Δλ pixels is `scale * Δλ`. To bring λ_center onto `cx` the translate must
 * move by `scale * (λ_current - λ_center)` — the *current* longitude minus the
 * wanted one. (Sign matters: the opposite order pushes the map twice as far off
 * centre instead of centring it.)
 */
const alignCountryLonCenter = (
  projection: GeoProjection,
  stage: FramingStage,
  rect: FramingRect,
  lonCenter: number,
  lonSpan: number,
  boundsInFrame?: FramingRect,
): GeoProjection => {
  if (!(lonSpan > 0) || !projection.invert) return projection;
  // Only meaningful when the frame holds (nearly) the whole country: then the
  // empty water is a composition choice. When the frame shows a fraction of the
  // country — one province, or a cluster on one side — sliding to the country's
  // midpoint would just push the subject off centre.
  //
  // The 95% tolerance is what keeps this working under a vertical squash: the
  // squeeze widens the landmass by ~14%, so a north-south chain that used to
  // span slightly less than the country can end up spanning slightly more.
  const visible = visibleLonSpanOf(projection, stage, rect);
  if (!(visible >= lonSpan * COUNTRY_CENTER_TOLERANCE)) return projection;
  const cx = rectCenter(rect)[0];
  const cy = rectCenter(rect)[1];
  const current = projection.invert([cx, cy]);
  if (!current || !Number.isFinite(current[0])) return projection;
  const scale = projection.scale();
  let shift = (scale * (current[0] - lonCenter) * Math.PI) / 180;
  if (!Number.isFinite(shift)) return projection;

  if (boundsInFrame) {
    // Only slide when the ranked set leaves horizontal slack. If it already
    // spans the rect width, the horizontal position is *pinned* by the data and
    // re-centring on the country would just shove a province towards an edge
    // (a single-province framing is the extreme case).
    const rectWidth = rect.x1 - rect.x0;
    const usedWidth = boundsInFrame.x1 - boundsInFrame.x0;
    if (rectWidth - usedWidth < rectWidth * 0.02) return projection;

    // How far the geography may slide before a ranked province leaves the rect.
    const line = 1;
    const minShift = rect.x0 - boundsInFrame.x0 - line;
    const maxShift = rect.x1 - boundsInFrame.x1 + line;
    // No room to move at all (the ranked set already fills the width): leave it.
    if (minShift > maxShift) return projection;
    shift = clamp(shift, minShift, maxShift);
  }

  if (Math.abs(shift) < 0.5) return projection;
  const [tx, ty] = projection.translate();
  return geoMercator()
    .scale(scale)
    .translate([tx + shift, ty]);
};

/* -------------------------------------------------------------------------- *
 * Vertical squash
 * -------------------------------------------------------------------------- */

/** The minimum surface `geoPath` needs from a projection stream. */
type GeoStreamSink = {
  point: (x: number, y: number, z?: number) => void;
  lineStart: () => void;
  lineEnd: () => void;
  polygonStart: () => void;
  polygonEnd: () => void;
  sphere?: () => void;
};

/**
 * Wraps a projection so its output is squeezed vertically by `k`, around the
 * horizontal line `pivotY`.
 *
 * The whole point of doing it *inside the projection* (rather than with an SVG
 * `scale(1, k)` on the map group) is that every consumer keeps working
 * unchanged: `geoPath` draws the squeezed outline, `path.centroid` /
 * `path.bounds` return squeezed coordinates — so labels, leader lines and the
 * coverage diagnostics all line up with what is actually painted. An SVG
 * transform would have squeezed the labels too, which is the one thing that
 * must never happen (squashed text looks broken).
 *
 * `invert` is remapped by the exact inverse, so lon/lat lookups stay correct.
 */
const squashProjection = (
  base: GeoProjection,
  k: number,
  pivotY: number,
): GeoProjection => {
  if (!(k > 0) || Math.abs(k - 1) < 1e-9) return base;
  const squashY = (y: number): number => pivotY + (y - pivotY) * k;
  const projection = ((lonlat: [number, number]) => {
    const point = base(lonlat);
    return point ? [point[0], squashY(point[1])] : point;
  }) as unknown as GeoProjection;
  projection.invert = (point: [number, number]) =>
    base.invert
      ? base.invert([point[0], pivotY + (point[1] - pivotY) / k])
      : null;
  projection.stream = (sink: GeoStreamSink) =>
    base.stream({
      point: (x: number, y: number, z?: number) => sink.point(x, squashY(y), z ?? 0),
      lineStart: () => sink.lineStart(),
      lineEnd: () => sink.lineEnd(),
      polygonStart: () => sink.polygonStart(),
      polygonEnd: () => sink.polygonEnd(),
      sphere: () => sink.sphere?.(),
    } as unknown as GeoStreamSink);
  projection.scale = base.scale;
  projection.translate = base.translate;
  projection.center = base.center;
  projection.precision = base.precision;
  return projection;
};

/**
 * Stretches a rect vertically by `1 / (1 - squash)` around its own centre.
 *
 * Fitting is done in this *unstretched* space and the projection squeezes the
 * result back down, so the fitted geography lands inside the original rect.
 * Concretely: fitting into `virtualRect` and then squashing by `k` is identical
 * to fitting into `rect` with independent x/y scale factors, but it keeps the
 * single-scale `fitExtent` path (and its outlier logic) untouched.
 */
const stretchVertically = (rect: FramingRect, squash: number): FramingRect => {
  if (!(squash > 0) || squash >= 1) return rect;
  const centerY = (rect.y0 + rect.y1) / 2;
  const halfHeight = (rect.y1 - rect.y0) / 2 / (1 - squash);
  return {x0: rect.x0, y0: centerY - halfHeight, x1: rect.x1, y1: centerY + halfHeight};
};

/** Applies the same squash to a measured metric, for human-facing diagnostics. */
const squashMetric = (metric: FrameMetric, k: number, pivotY: number): FrameMetric => {
  if (!(k > 0) || Math.abs(k - 1) < 1e-9) return metric;
  const squashY = (y: number): number => pivotY + (y - pivotY) * k;
  return {
    bbox: [
      [metric.bbox[0][0], squashY(metric.bbox[0][1])],
      [metric.bbox[1][0], squashY(metric.bbox[1][1])],
    ],
    areaPx: metric.areaPx * k,
    centroid: [metric.centroid[0], squashY(metric.centroid[1])],
  };
};

/* -------------------------------------------------------------------------- *
 * Result types
 * -------------------------------------------------------------------------- */
export type FramingDiagnostic = {
  provinceId: string;
  /** 1-based position inside the ranking input. */
  order: number;
  inside: boolean;
  areaPx: number;
  sizePx: [number, number];
  center: [number, number];
  /**
   * The projected bounding box, `[[x0, y0], [x1, y1]]`.
   *
   * The floating label uses it to sit *next to* the province instead of on top
   * of it (and the safe-area audit uses the very same rectangle, so what the
   * audit checks is what the render draws). `sizePx` / `center` alone are not
   * enough: a panel has to know where the province's edges are.
   */
  bboxPx: [[number, number], [number, number]];
  /** Distance to the component-wise median of all matched regions, in pixels. */
  distanceFromCenterPx: number;
  /** Distance outside the frame, 0 when the region is fully inside. */
  outsidePx: number;
};

export type FramingViewport = {
  /** Mode that was actually used (a fallback may differ from `requestedMode`). */
  mode: FitMode;
  requestedMode: FitMode;
  preset: FramingPreset;
  coverageThreshold: number;
  /** False (default) means no ranked province was allowed to leave the frame. */
  allowOutlierDrop: boolean;
  padding: number;
  /** Vertical squash actually applied (0 = true proportions). */
  squash: number;
  stage: FramingStage;
  /** The area the ranked regions are fitted into (full canvas minus edge safety). */
  rect: FramingRect;
  /** The area floating labels may occupy: `rect` minus the title/footer bands. */
  labelRect: FramingRect;
  center: [number, number];
  zoom: number;
  scale: number;
  translate: [number, number];
  coveredCount: number;
  totalCount: number;
  coverage: number;
  /** Context floor actually used (fraction of the country lon span, 0 = off). */
  contextFloor: number;
  /** Longitude span of the whole country, in degrees — the floor's reference. */
  countryLonSpan: number;
  /** Longitude span the final frame shows, in degrees. */
  visibleLonSpan: number;
  /** True when the context floor stepped the camera back for this viewport. */
  contextFloorApplied: boolean;
  /** Whether the intro camera move (whole country → this framing) is enabled. */
  cameraMove: boolean;
  keptIds: string[];
  droppedIds: string[];
  missingIds: string[];
  warnings: string[];
  diagnostics: FramingDiagnostic[];
  /** Zoom the whole country would need at this stage — the readable baseline. */
  referenceZoom: number;
  /**
   * Platform UI keep-out (right-hand action rail), present only when a safe area
   * was supplied. The map component keeps floating labels out of it.
   */
  keepOutRect?: FramingRect | null;
  /** The base-map area when a platform safe area was supplied. */
  mapRect?: FramingRect;
};

export type FramingFeature = {
  type: 'Feature';
  properties: {
    provinceId?: unknown;
    provinceEn?: unknown;
    provinceTh?: unknown;
  } | null;
  geometry: Geometry | null;
};

export type FramingGeoJson = {
  type: 'FeatureCollection';
  features: FramingFeature[];
};

/* -------------------------------------------------------------------------- *
 * Option normalisation / validation
 * -------------------------------------------------------------------------- */

const readOptions = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
};

/**
 * Validates user configuration. Illegal values never produce a broken viewport:
 * they fall back to the default and are reported in `warnings` so the caller can
 * surface them (UI / generation log).
 */
export const normalizeFramingOptions = (
  raw?: unknown,
): {options: ResolvedFramingOptions; warnings: string[]} => {
  const input = readOptions(raw);
  const warnings: string[] = [];
  const options: ResolvedFramingOptions = {...DEFAULT_FRAMING_OPTIONS};

  if (input.fitMode !== undefined) {
    if (input.fitMode === 'full-country' || input.fitMode === 'data-driven' || input.fitMode === 'manual') {
      options.fitMode = input.fitMode;
    } else {
      warnings.push(`fitMode 取值非法（${String(input.fitMode)}），已回退为 ${options.fitMode}`);
    }
  }

  if (input.framingPreset !== undefined) {
    if (input.framingPreset === 'tight' || input.framingPreset === 'balanced' || input.framingPreset === 'wide') {
      options.framingPreset = input.framingPreset;
    } else {
      warnings.push(`framingPreset 取值非法（${String(input.framingPreset)}），已回退为 ${options.framingPreset}`);
    }
  }

  if (input.allowOutlierDrop !== undefined) {
    // Anything but the literal `true` keeps dropping off (no truthy coercion).
    options.allowOutlierDrop = input.allowOutlierDrop === true;
    if (typeof input.allowOutlierDrop !== 'boolean') {
      warnings.push(
        `allowOutlierDrop 必须是布尔值（收到 ${String(input.allowOutlierDrop)}），已按 false 处理（全部排名区域可见）`,
      );
    }
  }

  if (input.coverageThreshold !== undefined) {
    if (isFiniteNumber(input.coverageThreshold) && input.coverageThreshold > 0 && input.coverageThreshold <= 1) {
      options.coverageThreshold = input.coverageThreshold;
    } else {
      warnings.push(
        `coverageThreshold 必须是 (0, 1] 之间的数值（收到 ${String(input.coverageThreshold)}），已回退为 ${options.coverageThreshold}`,
      );
    }
  }

  // Hard guard: a sub-1 threshold alone can never hide a ranked province. Every
  // ranked province must be on screen unless dropping was explicitly enabled —
  // this also protects against stale clients that still post the old `0.9`.
  if (!options.allowOutlierDrop && options.coverageThreshold < 1) {
    warnings.push(
      `coverageThreshold=${options.coverageThreshold} 需要同时设置 allowOutlierDrop=true 才会生效；` +
        '已按 1（全部排名区域可见）处理',
    );
    options.coverageThreshold = 1;
  }

  const presetPadding = PRESET_RULES[options.framingPreset].padding;
  options.padding = presetPadding;
  if (input.padding !== undefined) {
    if (isFiniteNumber(input.padding) && input.padding >= 0 && input.padding <= 0.3) {
      options.padding = input.padding;
    } else {
      warnings.push(`padding 必须是 [0, 0.3] 之间的数值，已回退为 ${presetPadding}`);
    }
  }

  if (input.verticalSquash !== undefined) {
    if (isFiniteNumber(input.verticalSquash) && input.verticalSquash >= 0 && input.verticalSquash <= 0.25) {
      options.verticalSquash = input.verticalSquash;
    } else {
      warnings.push(
        `verticalSquash 必须是 [0, 0.25] 之间的数值（收到 ${String(input.verticalSquash)}），已回退为 ${options.verticalSquash}`,
      );
    }
  }

  const presetContextFloor = PRESET_RULES[options.framingPreset].contextFloor;
  options.contextFloor = presetContextFloor;
  if (input.contextFloor !== undefined) {
    if (isFiniteNumber(input.contextFloor) && input.contextFloor >= 0 && input.contextFloor < 1) {
      options.contextFloor = input.contextFloor;
    } else {
      warnings.push(
        `contextFloor 必须是 [0, 1) 之间的数值（0 = 关闭，收到 ${String(input.contextFloor)}），已回退为 ${presetContextFloor}`,
      );
    }
  }

  if (input.minZoom !== undefined) {
    if (isFiniteNumber(input.minZoom) && input.minZoom >= -2 && input.minZoom <= 24) {
      options.minZoom = input.minZoom;
    } else {
      warnings.push(`minZoom 取值非法（${String(input.minZoom)}），已回退为 ${options.minZoom}`);
    }
  }
  if (input.maxZoom !== undefined) {
    if (isFiniteNumber(input.maxZoom) && input.maxZoom >= -2 && input.maxZoom <= 24) {
      options.maxZoom = input.maxZoom;
    } else {
      warnings.push(`maxZoom 取值非法（${String(input.maxZoom)}），已回退为 ${options.maxZoom}`);
    }
  }
  if (options.maxZoom <= options.minZoom) {
    warnings.push(
      `maxZoom (${options.maxZoom}) 必须大于 minZoom (${options.minZoom})，已修正为 ${options.minZoom + 1}`,
    );
    options.maxZoom = Math.min(24, options.minZoom + 1);
  }

  if (input.strictCoverage !== undefined) {
    options.strictCoverage = input.strictCoverage === true;
  }

  if (input.cameraMove !== undefined) {
    if (typeof input.cameraMove === 'boolean') {
      options.cameraMove = input.cameraMove;
    } else {
      warnings.push(
        `cameraMove 必须是布尔值（收到 ${String(input.cameraMove)}），已回退为 ${options.cameraMove}`,
      );
    }
  }

  if (input.manualCenter !== undefined) {
    const candidate = input.manualCenter;
    const pair = Array.isArray(candidate) ? candidate : null;
    if (
      pair &&
      pair.length === 2 &&
      isFiniteNumber(Number(pair[0])) &&
      isFiniteNumber(Number(pair[1])) &&
      Math.abs(Number(pair[0])) <= 180 &&
      Math.abs(Number(pair[1])) <= 85
    ) {
      options.manualCenter = [Number(pair[0]), Number(pair[1])];
    } else {
      warnings.push('manualCenter 必须是 [经度, 纬度] 且经度 ∈ [-180, 180]、纬度 ∈ [-85, 85]');
    }
  }

  if (input.manualZoom !== undefined) {
    const zoom = Number(input.manualZoom);
    if (isFiniteNumber(zoom)) {
      const bounded = clamp(zoom, options.minZoom, options.maxZoom);
      if (Math.abs(bounded - zoom) > 1e-9) {
        warnings.push(`manualZoom ${zoom} 超出 [${options.minZoom}, ${options.maxZoom}]，已收敛为 ${bounded}`);
      }
      options.manualZoom = bounded;
    } else {
      warnings.push(`manualZoom 取值非法（${String(input.manualZoom)}），已忽略`);
    }
  }

  return {options, warnings};
};

/* -------------------------------------------------------------------------- *
 * Stage / rect
 * -------------------------------------------------------------------------- */

const normalizeStage = (
  stage: FramingStage | undefined,
  warnings: string[],
): FramingStage => {
  if (!stage || !isFiniteNumber(stage.width) || !isFiniteNumber(stage.height)) {
    warnings.push('地图容器宽高异常，已回退为设计稿尺寸 1080 x 1920');
    return {...MAP_STAGE};
  }
  const width = Math.abs(stage.width);
  const height = Math.abs(stage.height);
  if (width < 120 || height < 120) {
    warnings.push(`地图容器宽高异常（${stage.width} x ${stage.height}），已回退为设计稿尺寸 1080 x 1920`);
    return {...MAP_STAGE};
  }
  return {width, height};
};

/**
 * Authored rect (no preset padding): the full canvas minus the edge safety.
 *
 * When a platform safe area is supplied, its `mapRect` replaces the built-in
 * bands — the map is fitted into the room the app's own UI leaves free. Width
 * is still allowed to run to the canvas edge (a base map may be cropped), while
 * top/bottom follow the platform's status bar and caption area.
 */
const authorRect = (stage: FramingStage, override?: FramingRect): FramingRect => {
  if (override) {
    return {
      x0: clamp(override.x0, 0, stage.width),
      y0: clamp(override.y0, 0, stage.height),
      x1: clamp(override.x1, 0, stage.width),
      y1: clamp(override.y1, 0, stage.height),
    };
  }
  return {
    x0: MAP_SAFE_INSET.left,
    y0: MAP_SAFE_INSET.top,
    x1: stage.width - MAP_SAFE_INSET.right,
    y1: stage.height - MAP_SAFE_INSET.bottom,
  };
};

const insetRect = (base: FramingRect, padding: number, warnings: string[]): FramingRect => {
  const span = Math.min(base.x1 - base.x0, base.y1 - base.y0);
  let extra = Math.round(clamp(padding, 0, 0.3) * span);
  const maxExtra = Math.max(0, Math.floor((span - MIN_RECT_SIZE) / 2));
  if (extra > maxExtra) {
    warnings.push(`padding ${padding} 超出可容纳范围，已收敛为 ${maxExtra}px`);
    extra = maxExtra;
  }
  return {
    x0: base.x0 + extra,
    y0: base.y0 + extra,
    x1: base.x1 - extra,
    y1: base.y1 - extra,
  };
};

const corners = (rect: FramingRect): [[number, number], [number, number]] => [
  [rect.x0, rect.y0],
  [rect.x1, rect.y1],
];

const rectCenter = (rect: FramingRect): [number, number] => [
  (rect.x0 + rect.x1) / 2,
  (rect.y0 + rect.y1) / 2,
];

/** Distance from a point to the rect, 0 when inside. */
const distanceToRect = (rect: FramingRect, x: number, y: number): number => {
  const dx = Math.max(rect.x0 - x, 0, x - rect.x1);
  const dy = Math.max(rect.y0 - y, 0, y - rect.y1);
  return Math.hypot(dx, dy);
};

/* -------------------------------------------------------------------------- *
 * Geometry index (static cache — built once per GeoJSON object)
 * -------------------------------------------------------------------------- */

type FrameMetric = {
  bbox: [[number, number], [number, number]];
  areaPx: number;
  centroid: [number, number];
};

type GeoIndex = {
  featureById: Map<string, FramingFeature>;
  metrics: Map<string, FrameMetric>;
  /** Features with usable geometry — every fit runs against this collection. */
  usable: FramingGeoJson;
  /** Features whose geometry could not be measured (locatable warnings). */
  invalidIds: string[];
  referenceScale: number;
  /** Longitude span of the whole country, in degrees (context-floor reference). */
  lonSpan: number;
  /** Longitude of the country's horizontal midpoint (0 when unmeasurable). */
  lonCenter: number;
};

const indexCache = new WeakMap<object, GeoIndex>();

const measure = (path: ReturnType<typeof geoPath>, feature: FramingFeature): FrameMetric | null => {
  const geometry = feature.geometry;
  if (!geometry || typeof geometry !== 'object' || typeof geometry.type !== 'string') return null;
  const bounds = path.bounds(feature as unknown as GeoPermissibleObjects);
  const centroid = path.centroid(feature as unknown as GeoPermissibleObjects);
  const flat = [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1], centroid[0], centroid[1]];
  if (!flat.every(Number.isFinite)) return null;
  if (bounds[1][0] - bounds[0][0] <= 0 && bounds[1][1] - bounds[0][1] <= 0) return null;
  const area = path.area(feature as unknown as GeoPermissibleObjects);
  return {
    bbox: bounds,
    areaPx: Number.isFinite(area) ? Math.abs(area) : 0,
    centroid: [centroid[0], centroid[1]],
  };
};

/**
 * Builds (and caches) the id → feature index plus per-province pixel metrics in
 * the authored full-country reference projection. The reference projection is
 * deliberately fixed so metrics stay comparable across every configuration, and
 * so the whole GeoJSON is traversed only once per process.
 */
const buildGeoIndex = (geojson: FramingGeoJson): GeoIndex => {
  const cached = indexCache.get(geojson as unknown as object);
  if (cached) return cached;

  const featureById = new Map<string, FramingFeature>();
  for (const feature of geojson.features ?? []) {
    const id = normalizeId(feature?.properties?.provinceId);
    if (!id || featureById.has(id)) continue;
    featureById.set(id, feature);
  }

  // Measure everything once against a fixed reference projection. Features with
  // unusable geometry are dropped from `usable` so a single corrupt ring can
  // never poison the fit with NaN bounds.
  const referenceProjection = geoMercator().fitExtent(
    corners(authorRect(MAP_STAGE)),
    geojson as unknown as GeoPermissibleObjects,
  );
  const path = geoPath(referenceProjection);
  const metrics = new Map<string, FrameMetric>();
  const usableFeatures: FramingFeature[] = [];
  const invalidIds: string[] = [];
  for (const [id, feature] of featureById) {
    const metric = measure(path, feature);
    if (!metric) {
      invalidIds.push(id);
      continue;
    }
    metrics.set(id, metric);
    usableFeatures.push(feature);
  }

  const lonBounds = countryLonBounds(geojson);
  const index: GeoIndex = {
    featureById,
    metrics,
    usable: {type: 'FeatureCollection', features: usableFeatures},
    invalidIds,
    referenceScale: referenceProjection.scale(),
    lonSpan: lonBounds ? lonBounds.east - lonBounds.west : 0,
    lonCenter: lonBounds ? (lonBounds.west + lonBounds.east) / 2 : 0,
  };
  indexCache.set(geojson as unknown as object, index);
  return index;
};

/* -------------------------------------------------------------------------- *
 * Outlier-aware subset selection
 * -------------------------------------------------------------------------- */

type Candidate = {
  provinceId: string;
  order: number;
  feature: FramingFeature;
  metric: FrameMetric;
};

const toCollection = (candidates: Candidate[]): FramingGeoJson => ({
  type: 'FeatureCollection',
  features: candidates.map((candidate) => candidate.feature),
});

const fitScale = (candidates: Candidate[], rect: FramingRect): number =>
  geoMercator()
    .fitExtent(corners(rect), toCollection(candidates) as unknown as GeoPermissibleObjects)
    .scale();

/** Component-wise median: deterministic, outlier resistant, no iteration. */
const medianCenter = (values: Array<[number, number]>): [number, number] => {
  const axis = (index: 0 | 1): number => {
    const sorted = values.map((value) => value[index]).sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  return values.length ? [axis(0), axis(1)] : [0, 0];
};

/**
 * Greedy outlier removal.
 *
 * Coverage is defined as *count based*: one ranking entry = one unit, so a
 * physically large province never dominates the framing decision. The loop only
 * drops a region when doing so unlocks a meaningful zoom gain
 * (`minZoomGain` from the preset), and never below the coverage floor implied by
 * `coverageThreshold`. The result is deterministic: candidates are probed
 * worst-ranking-first so ties always drop the lowest ranked region.
 */
const selectFramed = (
  candidates: Candidate[],
  rect: FramingRect,
  options: ResolvedFramingOptions,
): Candidate[] => {
  const total = candidates.length;
  if (total <= 1) return candidates.slice();

  const rules = PRESET_RULES[options.framingPreset];
  const target = clamp(
    options.coverageThreshold * rules.coverageFactor + rules.coverageBonus,
    0,
    1,
  );
  // `floor`, not `ceil`: with `ceil`, any list shorter than ~10 entries could
  // never drop a single outlier (ceil(0.9 × 6) = 6), and one far-away province
  // then drags the whole north-south chain into the frame and forces the camera
  // out to the full country width. The fractional slot is exactly the outlier
  // allowance the threshold promises, so rounding it down is the honest read.
  // Full coverage (the default): nothing may leave the frame, so there is no
  // trade to evaluate at all. Dropping requires the explicit opt-in.
  if (!options.allowOutlierDrop || target >= 1 - 1e-9) return candidates.slice();

  const minKept = Math.max(1, Math.min(total, Math.floor(target * total + 1e-9)));

  let kept = candidates.slice();
  let best = fitScale(kept, rect);
  let guard = 0;

  while (kept.length > minKept && kept.length > 1 && guard < 64) {
    guard += 1;

    // Probe the most geographically isolated regions first; on large inputs we
    // cap the probe list so the loop stays well under a few hundred fits.
    const median = medianCenter(kept.map((candidate) => candidate.metric.centroid));
    const isolation = (candidate: Candidate): number =>
      Math.hypot(
        candidate.metric.centroid[0] - median[0],
        candidate.metric.centroid[1] - median[1],
      );
    const probeCount = kept.length <= 24 ? kept.length : Math.max(3, Math.ceil(kept.length * 0.4));
    const probes = new Set(
      kept
        .slice()
        .sort((a, b) => isolation(b) - isolation(a))
        .slice(0, probeCount)
        .map((candidate) => candidate.provinceId),
    );

    let dropIndex = -1;
    let dropGain = 0;
    // Worst ranking first: strict `>` keeps the lowest ranked region on ties.
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      if (!probes.has(kept[index].provinceId)) continue;
      const trial = kept.filter((_, position) => position !== index);
      const gain = fitScale(trial, rect) / best;
      if (gain > dropGain + 1e-9) {
        dropGain = gain;
        dropIndex = index;
      }
    }

    if (dropIndex < 0 || dropGain < rules.minZoomGain) break;

    kept = kept.filter((_, position) => position !== dropIndex);
    best = fitScale(kept, rect);
  }

  return kept;
};

/* -------------------------------------------------------------------------- *
 * resolveViewport
 * -------------------------------------------------------------------------- */

const viewportCache = new WeakMap<object, Map<string, FramingViewport>>();

const rectKey = (rect: FramingRect | undefined): string =>
  rect ? `${rect.x0},${rect.y0},${rect.x1},${rect.y1}` : '-';

const cacheKey = (
  ids: string[],
  options: ResolvedFramingOptions,
  stage: FramingStage,
  safe: FramingSafeArea | undefined,
): string =>
  [
    options.fitMode,
    options.framingPreset,
    options.coverageThreshold,
    options.allowOutlierDrop ? 1 : 0,
    options.padding,
    options.verticalSquash,
    options.contextFloor,
    options.minZoom,
    options.maxZoom,
    options.cameraMove ? 1 : 0,
    options.strictCoverage ? 1 : 0,
    options.manualCenter ? options.manualCenter.join(',') : '-',
    options.manualZoom ?? '-',
    `${stage.width}x${stage.height}`,
    rectKey(safe?.fitRect),
    rectKey(safe?.mapRect),
    rectKey(safe?.labelRect),
    ids.join(','),
  ].join('|');

/**
 * Resolves the static viewport for one video.
 *
 * @param geojson      The full province GeoJSON (never mutated, never filtered).
 * @param provinceIds  `provinceId` of every ranking entry, in ranking order.
 * @param rawOptions   User configuration (`project.framing` / request body).
 * @param stage        Map container size in SVG user units.
 * @param safe         Resolved platform UI safe area (optional). Omit it and the
 *                     built-in bands apply — identical to the previous behaviour.
 */
export const resolveViewport = (
  geojson: FramingGeoJson,
  provinceIds: string[],
  rawOptions?: unknown,
  stage?: FramingStage,
  safe?: FramingSafeArea,
): FramingViewport => {
  const {options, warnings} = normalizeFramingOptions(rawOptions);
  const safeStage = normalizeStage(stage, warnings);
  const ids = (Array.isArray(provinceIds) ? provinceIds : []).map(normalizeId);
  const key = cacheKey(ids, options, safeStage, safe);
  // Non-canonical input is never cached: two different raw values that normalise
  // to the same options must still surface their own warnings.
  const cacheable = warnings.length === 0;

  const bucket = viewportCache.get(geojson as unknown as object);
  const cached = cacheable ? bucket?.get(key) : undefined;
  if (cached) return cached;

  // The ranked provinces are fitted into the platform's **core content area**
  // when one is supplied: a province whose shape runs under the status bar or
  // the caption is not actually readable. Falling back to `mapRect` keeps the
  // old bleed behaviour for callers that do not pass a safe area.
  const authoredRect = authorRect(safeStage, safe?.fitRect ?? safe?.mapRect);
  const rect = insetRect(authoredRect, options.padding, warnings);
  // Everything below fits against `fitRect`, which is `rect` stretched
  // vertically by 1/(1-squash); `createProjection` squeezes it back down, so the
  // geography lands inside `rect` while being 1/(1-squash) times wider. Fitting
  // and measuring in this space keeps a single x/y scale factor, so the outlier
  // and context-floor logic needs no special case.
  const squash = clamp(options.verticalSquash, 0, 0.25);
  const squashK = 1 - squash;
  const fitRect = stretchVertically(rect, squash);
  // The whole-country view uses the *unpadded* area, so "the whole country with
  // a margin" stays strictly smaller than "the whole country" — that is what the
  // never-smaller-than-full-country fallback compares against.
  const fullRect = stretchVertically(authoredRect, squash);
  const safeLabelRect = safe?.labelRect
    ? {
        x0: clamp(safe.labelRect.x0, 0, safeStage.width),
        y0: clamp(safe.labelRect.y0, 0, safeStage.height),
        x1: clamp(safe.labelRect.x1, 0, safeStage.width),
        y1: clamp(safe.labelRect.y1, 0, safeStage.height),
      }
    : labelRectFor(safeStage);
  const index = buildGeoIndex(geojson);

  /* 1. ranking entries → GeoJSON features (stable id matching, never by name) */
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const missingIds: string[] = [];

  ids.forEach((id, position) => {
    if (!id) {
      warnings.push(`第 ${position + 1} 条排名缺少 provinceId，已跳过取景计算`);
      return;
    }
    if (seen.has(id)) {
      warnings.push(`provinceId ${id} 重复出现，取景计算只计一次`);
      return;
    }
    seen.add(id);

    const feature = index.featureById.get(id);
    if (!feature) {
      missingIds.push(id);
      warnings.push(`排名区域 ${id} 在 GeoJSON 中找不到对应要素，已排除出取景计算`);
      return;
    }
    const metric = index.metrics.get(id);
    if (!metric) {
      missingIds.push(id);
      warnings.push(`排名区域 ${id} 的几何无效，已排除出取景计算`);
      return;
    }
    candidates.push({provinceId: id, order: position + 1, feature, metric});
  });

  let mode = options.fitMode;
  if (mode === 'manual' && !options.manualCenter) {
    warnings.push('manual 模式缺少有效的 manualCenter，已回退为 data-driven');
    mode = 'data-driven';
  }
  if (!candidates.length) {
    warnings.push('没有可用于取景的排名区域，已回退为完整国家地图');
    mode = 'full-country';
  }

  /* 2. compute the projection for the selected mode */
  const fitWholeCountry = (target: FramingRect): GeoProjection => {
    if (!index.usable.features.length) {
      warnings.push('GeoJSON 中没有任何可用的行政区几何，已退回默认比例尺');
      const fallback = rectCenter(target);
      return geoMercator()
        .scale(index.referenceScale)
        .translate([fallback[0], fallback[1]]);
    }
    return geoMercator().fitExtent(
      corners(target),
      index.usable as unknown as GeoPermissibleObjects,
    );
  };

  let projection: GeoProjection;
  let contextFloorApplied = false;
  // The provinces that are *supposed* to be on screen. With outlier dropping
  // enabled this is smaller than `candidates` — the containment pass below must
  // never chase a province that was deliberately traded away for zoom.
  let keepSet: Candidate[] = candidates;
  if (mode === 'full-country') {
    // The authored rect: always shows the whole country, now across the whole
    // canvas instead of the smaller box the map used to be confined to.
    projection = fitWholeCountry(fullRect);
  } else if (mode === 'manual') {
    const center = options.manualCenter ?? DEFAULT_CENTER;
    const zoom = clamp(
      options.manualZoom ?? scaleToZoom(index.referenceScale),
      options.minZoom,
      options.maxZoom,
    );
    const scale = zoomToScale(zoom);
    // Translate so `center` lands on the middle of the frame; this is the exact
    // inverse of `invert` and needs no `center()` state juggling.
    const origin = geoMercator().scale(scale).translate([0, 0]);
    const projected = origin([center[0], center[1]]) ?? [0, 0];
    projection = geoMercator()
      .scale(scale)
      .translate([rectCenter(rect)[0] - projected[0], rectCenter(rect)[1] - projected[1]]);
  } else {
    const framed = selectFramed(candidates, fitRect, options);
    keepSet = framed;
    projection = geoMercator().fitExtent(
      corners(fitRect),
      toCollection(framed) as unknown as GeoPermissibleObjects,
    );

    // Context floor. `contain` fitting is driven by the ranked regions alone, so
    // a set that happens to sit on one north-south line fills the frame with a
    // narrow strip and zooms until the picture holds a sliver of the country
    // only — white land on white land, with no coast or border left to place it.
    // Stepping back until the frame shows `contextFloor × country lon span`
    // restores the silhouette. Stepping back can never push a ranked region out
    // of frame, so coverage is untouched; it only trades size for recognisability
    // and only when the frame would otherwise be narrower than the floor.
    if (options.contextFloor > 0 && index.lonSpan > 0) {
      const floorSpan = index.lonSpan * options.contextFloor;
      const visibleSpan = visibleLonSpanOf(projection, safeStage, fitRect);
      if (visibleSpan > 0 && visibleSpan < floorSpan - 1e-6) {
        projection = rescaleKeepingPivot(
          projection,
          projection.scale() * (visibleSpan / floorSpan),
          rectCenter(rect),
        );
        contextFloorApplied = true;
        warnings.push(
          `自动取景画面只横跨 ${visibleSpan.toFixed(2)}° 经度（全国 ${index.lonSpan.toFixed(2)}°），` +
            `为保住版图可辨识度已后退到 ${floorSpan.toFixed(2)}°（contextFloor=${options.contextFloor}）`,
        );
      }
    }

    // Hard zoom limits so a pathological dataset can never zoom to infinity or
    // collapse into the whole country by accident.
    const rawScale = projection.scale();
    const bounded = clamp(rawScale, zoomToScale(options.minZoom), zoomToScale(options.maxZoom));
    if (Math.abs(bounded - rawScale) > 1e-6) {
      // `scale()` alone would keep the translate of the *unclamped* fit, which
      // slides the intended centre off frame. Re-anchor on the same geographic
      // centre the frame currently shows.
      projection = rescaleKeepingPivot(projection, bounded, rectCenter(rect));
      warnings.push(
        `自动取景 zoom ${scaleToZoom(rawScale).toFixed(2)} 超出限制 [${options.minZoom}, ${options.maxZoom}]，已收敛为 ${scaleToZoom(bounded).toFixed(2)}`,
      );
    }

    // Never smaller than the whole country. A ranked set that spans the country
    // (or a north-south chain covering its full height) can fit *below* the
    // full-country scale, because the framing rect is inset by `padding` while
    // the full-country view uses the whole free area. Showing the country with a
    // margin around it is strictly worse than showing the country: fall back to
    // the full-country fit, which still contains every ranked province.
    const wholeCountryScale = fitWholeCountry(fullRect).scale();
    if (projection.scale() < wholeCountryScale - 1e-6 && framed.length >= candidates.length) {
      projection = fitWholeCountry(fullRect);
    }

    // Every ranked province is inside the frame: with the frame wider than the
    // ranked strip, re-centre horizontally on the country so the empty margin is
    // split instead of piling up on one side. The shift is clamped to the room
    // the ranked set leaves, so this can never trade centring for coverage.
    if (framed.length >= candidates.length) {
      const unionPath = geoPath(projection);
      const boundsInFrame = candidates.reduce<FramingRect | null>((acc, candidate) => {
        const metric = measure(unionPath, candidate.feature);
        if (!metric) return acc;
        const box: FramingRect = {
          x0: metric.bbox[0][0],
          y0: metric.bbox[0][1],
          x1: metric.bbox[1][0],
          y1: metric.bbox[1][1],
        };
        return acc
          ? {
              x0: Math.min(acc.x0, box.x0),
              y0: Math.min(acc.y0, box.y0),
              x1: Math.max(acc.x1, box.x1),
              y1: Math.max(acc.y1, box.y1),
            }
          : box;
      }, null);
      projection = alignCountryLonCenter(
        projection,
        safeStage,
        fitRect,
        index.lonCenter,
        index.lonSpan,
        boundsInFrame ?? undefined,
      );
    }
  }

  /* 2b. Hard guarantee: every ranked province is *fully* inside the fit rect.
   *
   * `selectFramed` already fits the kept set, but two later steps can shrink the
   * usable area without re-fitting: the zoom clamp (which only ever scales the
   * same centre) and `alignCountryLonCenter`. Anything that still pokes out is
   * pulled back by stepping the camera back a notch at a time — a few percent of
   * scale, at most a handful of iterations, so the composition barely moves.
   */
  const CONTAIN_EPSILON = 1;
  const fullyInside = (metric: FrameMetric, target: FramingRect): boolean =>
    metric.bbox[0][0] >= target.x0 - CONTAIN_EPSILON &&
    metric.bbox[0][1] >= target.y0 - CONTAIN_EPSILON &&
    metric.bbox[1][0] <= target.x1 + CONTAIN_EPSILON &&
    metric.bbox[1][1] <= target.y1 + CONTAIN_EPSILON;

  if (keepSet.length && mode !== 'manual') {
    // `minZoom` is an explicit user setting and wins over coverage: stepping
    // back past it would silently ignore what was asked for. In that case the
    // shortfall is reported instead of hidden.
    const scaleFloor = zoomToScale(options.minZoom);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const probePath = geoPath(projection);
      const overflow = keepSet.some((candidate) => {
        const metric = measure(probePath, candidate.feature);
        return metric ? !fullyInside(metric, fitRect) : false;
      });
      if (!overflow) break;
      const nextScale = Math.max(projection.scale() * 0.97, scaleFloor);
      if (nextScale >= projection.scale() - 1e-9) {
        warnings.push(
          `受 minZoom=${options.minZoom} 限制，无法再后退容纳全部排名区域；` +
            '如需全部可见，请调低 minZoom 或改用 manual 手动取景',
        );
        break;
      }
      projection = rescaleKeepingPivot(projection, nextScale, rectCenter(fitRect));
    }
  }

  /* 3. classify every matched region against the final frame */
  const path = geoPath(projection);
  const framed = new Map<string, FrameMetric>();
  const covered: Candidate[] = [];
  const dropped: Candidate[] = [];
  candidates.forEach((candidate) => {
    const metric = measure(path, candidate.feature) ?? candidate.metric;
    framed.set(candidate.provinceId, metric);
    // Full containment, not mere intersection: a province whose outline is
    // half under the status bar is not "visible" even though it overlaps the
    // frame. The epsilon absorbs the sub-pixel error of fitting a boundary
    // exactly onto the rect edge.
    const inside = fullyInside(metric, fitRect);
    (inside ? covered : dropped).push(candidate);
  });

  const totalCount = candidates.length;
  const coverage = totalCount ? covered.length / totalCount : 0;

  if (dropped.length) {
    const list = dropped.map((candidate) => candidate.provinceId).join('、');
    warnings.push(`以下排名区域未进入画面（排名与解说仍完整保留）：${list}`);
    if (options.strictCoverage) {
      warnings.push(
        `严格覆盖模式：当前视口未能覆盖全部排名区域（${covered.length}/${totalCount}，目标 ${options.coverageThreshold}）。` +
          '如需全部覆盖，请把 coverageThreshold 设为 1（默认值即全部可见），或改用 manual 手动取景。',
      );
    }
  }

  /* 4. diagnostics for the UI / generation log */
  // Reported in *on-screen* coordinates: metrics are measured in the stretched
  // fit space, so they are squeezed back here before being handed out. Anything
  // that reads these numbers (preview, logs) then agrees with the pixels.
  const squashPivotY = (rect.y0 + rect.y1) / 2;
  const coveredIds = new Set(covered.map((candidate) => candidate.provinceId));
  const median = medianCenter(
    candidates.map((candidate) =>
      squashMetric(framed.get(candidate.provinceId)!, squashK, squashPivotY).centroid,
    ),
  );
  const diagnostics: FramingDiagnostic[] = candidates.map((candidate) => {
    const metric = squashMetric(framed.get(candidate.provinceId)!, squashK, squashPivotY);
    return {
      provinceId: candidate.provinceId,
      order: candidate.order,
      inside: coveredIds.has(candidate.provinceId),
      areaPx: Math.round(metric.areaPx),
      sizePx: [
        Math.round(metric.bbox[1][0] - metric.bbox[0][0]),
        Math.round(metric.bbox[1][1] - metric.bbox[0][1]),
      ],
      center: [Math.round(metric.centroid[0]), Math.round(metric.centroid[1])],
      bboxPx: metric.bbox,
      distanceFromCenterPx: Math.round(
        Math.hypot(metric.centroid[0] - median[0], metric.centroid[1] - median[1]),
      ),
      outsidePx: Math.round(distanceToRect(rect, metric.centroid[0], metric.centroid[1])),
    };
  });

  /* 5. reference zoom (whole country at this stage) — the readability baseline */
  const referenceScale =
    !safe && safeStage.width === MAP_STAGE.width && safeStage.height === MAP_STAGE.height
      ? index.referenceScale
      : fitWholeCountry(fullRect).scale();

  const [cx, cy] = rectCenter(rect);
  const inverted = projection.invert ? projection.invert([cx, cy]) : null;
  const center: [number, number] =
    inverted && Number.isFinite(inverted[0]) && Number.isFinite(inverted[1])
      ? [inverted[0], inverted[1]]
      : [...DEFAULT_CENTER];

  const translate = projection.translate();

  // Safe-area diagnostics travel with the viewport, so the generation log and the
  // UI show the same warnings as the framing ones.
  (safe?.warnings ?? []).forEach((warning) => {
    if (!warnings.includes(warning)) warnings.push(warning);
  });

  const viewport: FramingViewport = {
    mode,
    requestedMode: options.fitMode,
    preset: options.framingPreset,
    coverageThreshold: options.coverageThreshold,
    allowOutlierDrop: options.allowOutlierDrop,
    padding: options.padding,
    squash,
    contextFloor: options.contextFloor,
    countryLonSpan: index.lonSpan,
    visibleLonSpan: visibleLonSpanOf(projection, safeStage, fitRect),
    contextFloorApplied,
    cameraMove: options.cameraMove,
    stage: safeStage,
    rect,
    labelRect: safeLabelRect,
    center,
    zoom: scaleToZoom(projection.scale()),
    scale: projection.scale(),
    translate: [translate[0], translate[1]],
    coveredCount: covered.length,
    totalCount,
    coverage,
    keptIds: covered.map((candidate) => candidate.provinceId),
    droppedIds: dropped.map((candidate) => candidate.provinceId),
    missingIds,
    warnings,
    diagnostics,
    referenceZoom: scaleToZoom(referenceScale),
    ...(safe
      ? {
          keepOutRect: safe.keepOutRect ?? null,
          mapRect: authoredRect,
        }
      : {}),
  };

  const nextBucket = bucket ?? new Map<string, FramingViewport>();
  if (cacheable) {
    if (nextBucket.size > 32) nextBucket.clear();
    nextBucket.set(key, viewport);
    if (!bucket) viewportCache.set(geojson as unknown as object, nextBucket);
  }

  return viewport;
};

/**
 * Rebuilds the *exact* projection of a resolved viewport (render + preview).
 *
 * The squash is applied here, inside the projection, so the SVG renderer, the
 * browser preview, the label placer and the diagnostics all consume the same
 * squeezed coordinates — there is no second place that could disagree.
 */
export const createProjection = (viewport: FramingViewport): GeoProjection => {
  const base = geoMercator()
    .scale(viewport.scale)
    .translate([viewport.translate[0], viewport.translate[1]]);
  const squash = viewport.squash ?? 0;
  if (!(squash > 0)) return base;
  return squashProjection(base, 1 - squash, (viewport.rect.y0 + viewport.rect.y1) / 2);
};

/**
 * Ease-in-out (cubic). A camera move that starts and stops linearly reads as a
 * mechanical slide; easing it is what makes it feel like a camera.
 */
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/**
 * Blends two resolved viewports into the camera position `progress` of the way
 * from `from` to `to` (`0` = exactly `from`, `1` = exactly `to`).
 *
 * This is the whole intro camera move: the fit itself is still resolved once
 * (start = whole country, end = the data-driven framing), and every frame in
 * between is a plain interpolation of *zoom* and *geographic centre*. Zoom is
 * interpolated in log space, so the perceived zoom speed is constant (moving
 * from zoom 3.2 to 7.9 must not accelerate halfway), and the centre is
 * interpolated in lon/lat, which keeps the camera aimed at the place it passes
 * over instead of drifting sideways.
 *
 * Everything else (fit rects, label box, keep-out, coverage diagnostics) is
 * taken from `to`: those describe the destination, and nothing reads them until
 * the move is over.
 */
export const blendViewport = (
  from: FramingViewport,
  to: FramingViewport,
  progress: number,
): FramingViewport => {
  const t = clamp(Number.isFinite(progress) ? progress : 1, 0, 1);
  if (t <= 0) return from;
  if (t >= 1) return to;

  const eased = easeInOut(t);
  const zoom = from.zoom + (to.zoom - from.zoom) * eased;
  const scale = zoomToScale(zoom);
  const center: [number, number] = [
    from.center[0] + (to.center[0] - from.center[0]) * eased,
    from.center[1] + (to.center[1] - from.center[1]) * eased,
  ];
  // Keep the interpolated centre on the *destination* frame centre: the camera
  // slides over the geography rather than the geography sliding out of frame.
  const pivot = rectCenter(to.rect);
  const origin = geoMercator().scale(scale).translate([0, 0]);
  const projected = origin(center) ?? [0, 0];
  const translate: [number, number] = [
    pivot[0] - projected[0],
    pivot[1] - projected[1],
  ];
  const projection = geoMercator().scale(scale).translate(translate);

  return {
    ...to,
    center,
    zoom,
    scale,
    translate,
    visibleLonSpan: visibleLonSpanOf(projection, to.stage, to.rect),
  };
};

/**
 * Projects every province with the resolved viewport into SVG path data.
 *
 * The React map component builds the same projection inline (per frame); this
 * helper exists for non-React consumers — the dev server uses it to render the
 * browser preview with the identical projection, so preview and MP4 can never
 * disagree.
 */
export const projectFeatures = (
  viewport: FramingViewport,
  geojson: FramingGeoJson,
): Array<{id: string; name: string; d: string}> => {
  const path = geoPath(createProjection(viewport));
  const result: Array<{id: string; name: string; d: string}> = [];
  for (const feature of geojson.features ?? []) {
    const id = normalizeId(feature?.properties?.provinceId);
    if (!id) continue;
    const d = path(feature as unknown as GeoPermissibleObjects);
    if (d) result.push({id, name: String(feature?.properties?.provinceEn ?? ''), d});
  }
  return result;
};

/** Human readable summary lines for the generation log / UI. */
export const describeViewport = (viewport: FramingViewport): string[] => {
  const lines = [
    `取景模式 ${viewport.mode}（松紧 ${viewport.preset}）`,
    `画布 ${viewport.stage.width}x${viewport.stage.height}（地图全出血垫底，标题与页脚浮于其上）`,
    `中心 纬度 ${viewport.center[1].toFixed(3)}, 经度 ${viewport.center[0].toFixed(3)} · zoom ${viewport.zoom.toFixed(2)} · scale ${viewport.scale.toFixed(0)}`,
    viewport.squash > 0
      ? `纵向压缩 ${(viewport.squash * 100).toFixed(0)}%（只压地理形状，文字与标签卡片不压；同等高度下地图宽约 ${((1 / (1 - viewport.squash)) * 100 - 100).toFixed(0)}%）`
      : '纵向压缩 关闭（等比，形状真实）',
    `覆盖 ${viewport.coveredCount}/${viewport.totalCount}（${(viewport.coverage * 100).toFixed(0)}%）` +
      (viewport.droppedIds.length
        ? ` · 画面外：${viewport.droppedIds.join('、')}`
        : ' · 全部排名区域在画面内'),
    `全图参考 zoom ${viewport.referenceZoom.toFixed(2)} · 相对全图放大 ${Math.pow(2, viewport.zoom - viewport.referenceZoom).toFixed(2)} 倍`,
    viewport.cameraMove
      ? '开场运镜 开启（开局 0.5s 后由全图推到上述取景，第一个名次念完镜头停住）'
      : '开场运镜 关闭（全片固定镜头）',
  ];
  if (viewport.countryLonSpan > 0) {
    lines.push(
      `画面横跨经度 ${viewport.visibleLonSpan.toFixed(2)}°（全国 ${viewport.countryLonSpan.toFixed(2)}°，占 ${(
        (viewport.visibleLonSpan / viewport.countryLonSpan) * 100
      ).toFixed(0)}%）` +
        (viewport.contextFloor > 0
          ? ` · 上下文地板 ${(viewport.contextFloor * 100).toFixed(0)}%${viewport.contextFloorApplied ? '（已触发后退）' : ''}`
          : ' · 上下文地板已关闭'),
    );
  }
  if (viewport.missingIds.length) {
    lines.push(`未匹配到 GeoJSON：${viewport.missingIds.join('、')}`);
  }
  return [...lines, ...viewport.warnings.map((warning) => `警告：${warning}`)];
};
