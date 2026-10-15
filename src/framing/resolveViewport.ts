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

import {geoMercator, geoPath} from 'd3-geo';
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
 * Screen bands the title header (top) and the footer (bottom) occupy. The top
 * one is doubly meaningful: it is the floor the *map itself* starts from, and it
 * keeps floating rank labels clear of the title. The render paints a gradient
 * scrim over both bands for the same reason.
 */
export const MAP_OVERLAY_BANDS = {top: 250, bottom: 130};

/**
 * Fit-rect insets. `top` deliberately equals the header band: the title is large
 * and dark, so the map starts *below* it instead of running underneath, which
 * keeps every ranked province unobstructed. The other three edges stay flush
 * with the canvas, so the map still uses the full width and the room behind the
 * footer.
 *
 * Because the header band takes the vertical room the footer band does not, the
 * stage keeps its full height — shrinking it would only cost zoom.
 */
export const MAP_SAFE_INSET = {
  top: MAP_OVERLAY_BANDS.top,
  right: 24,
  bottom: 24,
  left: 24,
};

/** The unobstructed band of the stage: floating labels are clamped into it. */
export const labelRectFor = (stage: FramingStage): FramingRect => ({
  x0: 0,
  y0: MAP_OVERLAY_BANDS.top,
  x1: stage.width,
  y1: Math.max(MAP_OVERLAY_BANDS.top, stage.height - MAP_OVERLAY_BANDS.bottom),
});

const MIN_RECT_SIZE = 80;
const WEB_MERCATOR_TILE_SIZE = 256;
const DEFAULT_CENTER: [number, number] = [100.5, 15];

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
  /** Extra inset ratio applied to the fit rect, 0 - 0.3. */
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
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
  minZoom: number;
  maxZoom: number;
  strictCoverage: boolean;
  manualCenter?: [number, number];
  manualZoom?: number;
};

export const DEFAULT_FRAMING_OPTIONS: ResolvedFramingOptions = {
  fitMode: 'data-driven',
  framingPreset: 'balanced',
  coverageThreshold: 0.9,
  padding: -1,
  minZoom: 5,
  maxZoom: 12,
  strictCoverage: false,
};

/** Per preset behaviour. `padding: -1` means "use the preset default". */
const PRESET_RULES: Record<
  FramingPreset,
  {padding: number; minZoomGain: number; coverageFactor: number; coverageBonus: number}
> = {
  // Zoom in hard: dropping outliers is cheap, a tiny zoom gain is enough.
  tight: {padding: 0.02, minZoomGain: 1.03, coverageFactor: 0.8, coverageBonus: 0},
  // Balance coverage and readability.
  balanced: {padding: 0.06, minZoomGain: 1.1, coverageFactor: 1, coverageBonus: 0},
  // Show more geography: only drop a region when it unlocks a big zoom gain.
  wide: {padding: 0.1, minZoomGain: 1.35, coverageFactor: 1, coverageBonus: 0.1},
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
  padding: number;
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
  keptIds: string[];
  droppedIds: string[];
  missingIds: string[];
  warnings: string[];
  diagnostics: FramingDiagnostic[];
  /** Zoom the whole country would need at this stage — the readable baseline. */
  referenceZoom: number;
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

  if (input.coverageThreshold !== undefined) {
    if (isFiniteNumber(input.coverageThreshold) && input.coverageThreshold > 0 && input.coverageThreshold <= 1) {
      options.coverageThreshold = input.coverageThreshold;
    } else {
      warnings.push(
        `coverageThreshold 必须是 (0, 1] 之间的数值（收到 ${String(input.coverageThreshold)}），已回退为 ${options.coverageThreshold}`,
      );
    }
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

/** Authored rect (no preset padding): the full canvas minus the edge safety. */
const authorRect = (stage: FramingStage): FramingRect => ({
  x0: MAP_SAFE_INSET.left,
  y0: MAP_SAFE_INSET.top,
  x1: stage.width - MAP_SAFE_INSET.right,
  y1: stage.height - MAP_SAFE_INSET.bottom,
});

const insetRect = (stage: FramingStage, padding: number, warnings: string[]): FramingRect => {
  const base = authorRect(stage);
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

  const index: GeoIndex = {
    featureById,
    metrics,
    usable: {type: 'FeatureCollection', features: usableFeatures},
    invalidIds,
    referenceScale: referenceProjection.scale(),
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
  const minKept = Math.max(1, Math.min(total, Math.ceil(target * total - 1e-9)));

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

const cacheKey = (
  ids: string[],
  options: ResolvedFramingOptions,
  stage: FramingStage,
): string =>
  [
    options.fitMode,
    options.framingPreset,
    options.coverageThreshold,
    options.padding,
    options.minZoom,
    options.maxZoom,
    options.strictCoverage ? 1 : 0,
    options.manualCenter ? options.manualCenter.join(',') : '-',
    options.manualZoom ?? '-',
    `${stage.width}x${stage.height}`,
    ids.join(','),
  ].join('|');

/**
 * Resolves the static viewport for one video.
 *
 * @param geojson      The full province GeoJSON (never mutated, never filtered).
 * @param provinceIds  `provinceId` of every ranking entry, in ranking order.
 * @param rawOptions   User configuration (`project.framing` / request body).
 * @param stage        Map container size in SVG user units.
 */
export const resolveViewport = (
  geojson: FramingGeoJson,
  provinceIds: string[],
  rawOptions?: unknown,
  stage?: FramingStage,
): FramingViewport => {
  const {options, warnings} = normalizeFramingOptions(rawOptions);
  const safeStage = normalizeStage(stage, warnings);
  const ids = (Array.isArray(provinceIds) ? provinceIds : []).map(normalizeId);
  const key = cacheKey(ids, options, safeStage);
  // Non-canonical input is never cached: two different raw values that normalise
  // to the same options must still surface their own warnings.
  const cacheable = warnings.length === 0;

  const bucket = viewportCache.get(geojson as unknown as object);
  const cached = cacheable ? bucket?.get(key) : undefined;
  if (cached) return cached;

  const rect = insetRect(safeStage, options.padding, warnings);
  const authoredRect = authorRect(safeStage);
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
  if (mode === 'full-country') {
    // The authored rect: always shows the whole country, now across the whole
    // canvas instead of the smaller box the map used to be confined to.
    projection = fitWholeCountry(authoredRect);
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
    const framed = selectFramed(candidates, rect, options);
    projection = geoMercator().fitExtent(
      corners(rect),
      toCollection(framed) as unknown as GeoPermissibleObjects,
    );

    // Hard zoom limits so a pathological dataset can never zoom to infinity or
    // collapse into the whole country by accident.
    const rawScale = projection.scale();
    const bounded = clamp(rawScale, zoomToScale(options.minZoom), zoomToScale(options.maxZoom));
    if (Math.abs(bounded - rawScale) > 1e-6) {
      // `scale()` alone would keep the translate of the *unclamped* fit, which
      // slides the intended centre off frame. Re-anchor on the same geographic
      // centre the frame currently shows.
      const anchor = projection.invert?.(rectCenter(rect)) ?? null;
      const centerPoint: [number, number] =
        anchor && Number.isFinite(anchor[0]) && Number.isFinite(anchor[1])
          ? [anchor[0], anchor[1]]
          : [DEFAULT_CENTER[0], DEFAULT_CENTER[1]];
      const target = rectCenter(rect);
      const origin = geoMercator().scale(bounded).translate([0, 0]);
      const projectedCenter = origin(centerPoint) ?? [0, 0];
      projection = geoMercator()
        .scale(bounded)
        .translate([target[0] - projectedCenter[0], target[1] - projectedCenter[1]]);
      warnings.push(
        `自动取景 zoom ${scaleToZoom(rawScale).toFixed(2)} 超出限制 [${options.minZoom}, ${options.maxZoom}]，已收敛为 ${scaleToZoom(bounded).toFixed(2)}`,
      );
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
    const inside =
      metric.bbox[1][0] > rect.x0 &&
      metric.bbox[0][0] < rect.x1 &&
      metric.bbox[1][1] > rect.y0 &&
      metric.bbox[0][1] < rect.y1;
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
          '如需全部覆盖，可改用 framingPreset=wide、提高 coverageThreshold，或改用 manual 手动取景。',
      );
    }
  }

  /* 4. diagnostics for the UI / generation log */
  const coveredIds = new Set(covered.map((candidate) => candidate.provinceId));
  const median = medianCenter(candidates.map((candidate) => framed.get(candidate.provinceId)!.centroid));
  const diagnostics: FramingDiagnostic[] = candidates.map((candidate) => {
    const metric = framed.get(candidate.provinceId)!;
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
      distanceFromCenterPx: Math.round(
        Math.hypot(metric.centroid[0] - median[0], metric.centroid[1] - median[1]),
      ),
      outsidePx: Math.round(distanceToRect(rect, metric.centroid[0], metric.centroid[1])),
    };
  });

  /* 5. reference zoom (whole country at this stage) — the readability baseline */
  const referenceScale =
    safeStage.width === MAP_STAGE.width && safeStage.height === MAP_STAGE.height
      ? index.referenceScale
      : fitWholeCountry(authoredRect).scale();

  const [cx, cy] = rectCenter(rect);
  const inverted = projection.invert ? projection.invert([cx, cy]) : null;
  const center: [number, number] =
    inverted && Number.isFinite(inverted[0]) && Number.isFinite(inverted[1])
      ? [inverted[0], inverted[1]]
      : [...DEFAULT_CENTER];

  const translate = projection.translate();
  const viewport: FramingViewport = {
    mode,
    requestedMode: options.fitMode,
    preset: options.framingPreset,
    coverageThreshold: options.coverageThreshold,
    padding: options.padding,
    stage: safeStage,
    rect,
    labelRect: labelRectFor(safeStage),
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
  };

  const nextBucket = bucket ?? new Map<string, FramingViewport>();
  if (cacheable) {
    if (nextBucket.size > 32) nextBucket.clear();
    nextBucket.set(key, viewport);
    if (!bucket) viewportCache.set(geojson as unknown as object, nextBucket);
  }

  return viewport;
};

/** Rebuilds the *exact* projection of a resolved viewport (render + preview). */
export const createProjection = (viewport: FramingViewport): GeoProjection =>
  geoMercator()
    .scale(viewport.scale)
    .translate([viewport.translate[0], viewport.translate[1]]);

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
    `覆盖 ${viewport.coveredCount}/${viewport.totalCount}（${(viewport.coverage * 100).toFixed(0)}%）` +
      (viewport.droppedIds.length
        ? ` · 画面外：${viewport.droppedIds.join('、')}`
        : ' · 全部排名区域在画面内'),
    `全图参考 zoom ${viewport.referenceZoom.toFixed(2)} · 相对全图放大 ${Math.pow(2, viewport.zoom - viewport.referenceZoom).toFixed(2)} 倍`,
  ];
  if (viewport.missingIds.length) {
    lines.push(`未匹配到 GeoJSON：${viewport.missingIds.join('、')}`);
  }
  return [...lines, ...viewport.warnings.map((warning) => `警告：${warning}`)];
};
