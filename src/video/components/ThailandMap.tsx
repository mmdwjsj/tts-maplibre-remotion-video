import React, {useMemo} from 'react';
import {geoPath} from 'd3-geo';
import {spring, useCurrentFrame, useVideoConfig} from 'remotion';
import type {ProjectData, RankingDatum, ThailandGeoJson} from '../../types';
import {theme} from '../../config/theme';
import {createProjection} from '../../framing/resolveViewport';
import type {FramingRect, FramingViewport} from '../../framing/resolveViewport';
import {LABEL_BOX, placeLabel} from '../layout/labelPlacement';
import type {LabelRect} from '../layout/labelPlacement';

type Props = {
  geojson: ThailandGeoJson;
  project: ProjectData;
  /**
   * Provinces already lit, in the order they were revealed — each keeps its
   * readout on screen from `revealAt` until the end of the video. They are not
   * cleared when the narration moves on: the map accumulates the ranking, which
   * is also what the final hold frame shows.
   */
  revealed: {datum: RankingDatum; revealAt: number}[];
  active?: RankingDatum;
  /** Frame the highlight animation starts — the instant the province is named. */
  revealStart: number;
  /**
   * Static viewport resolved once for the whole video. The map never re-derives
   * centre/zoom per frame, so the camera is identical in every frame.
   */
  framing: FramingViewport;
};

const LABEL_WIDTH = LABEL_BOX.width;

/** Ranking ids and GeoJSON ids are matched on a normalised key, never on names. */
const idKey = (value: unknown) => String(value ?? '').trim().toUpperCase();

/**
 * Fill for a revealed province: the rank colour scale (1 → 5), clamped so a
 * ranking longer than the scale reuses the last colour instead of going
 * undefined. Colour, not opacity, carries the rank — the scale stays readable
 * on the light basemap.
 */
const fillForRank = (rank: number): string =>
  theme.rankFill[Math.min(rank, theme.rankFill.length) - 1] ?? theme.rankFallbackFill;

/**
 * The rank readout is plain text, so it has to survive on top of both the sea and
 * a filled province. A white halo (stroke painted under the fill) does that
 * without bringing back a card: `paintOrder: stroke` keeps the glyph shape crisp
 * while the stroke acts as an outline, exactly like a subtitle on a photo.
 */
const HALO = {
  stroke: '#FFFFFF',
  strokeWidth: 7,
  strokeLinejoin: 'round' as const,
  paintOrder: 'stroke' as const,
};

/** Baseline offsets inside the label block, top-down: rank, name, value. */
const LABEL_RANK_Y = 24;
const LABEL_NAME_Y = 66;
const LABEL_VALUE_Y = 96;

export const ThailandMap: React.FC<Props> = ({geojson, project, revealed, active, revealStart, framing}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const projection = useMemo(() => createProjection(framing), [framing]);
  const path = useMemo(() => geoPath(projection), [projection]);
  const byId = useMemo(
    () => new Map(project.rankings.map((ranking) => [idKey(ranking.provinceId), ranking])),
    [project.rankings],
  );
  const visibleIdSet = useMemo(
    () => new Set(revealed.map(({datum}) => idKey(datum.provinceId))),
    [revealed],
  );
  const renderedFeatures = useMemo(() => geojson.features.map((feature) => ({
    feature,
    id: idKey(feature.properties.provinceId),
    path: path(feature) ?? '',
    center: path.centroid(feature),
    bounds: path.bounds(feature) as [[number, number], [number, number]],
  })), [geojson.features, path]);
  const activeProgress = active ? spring({frame: frame-revealStart, fps, config: {damping: 15, stiffness: 130}}) : 0;
  const activeFeature = active
    ? renderedFeatures.find((feature) => feature.id === idKey(active.provinceId))
    : undefined;
  // The readout **sits on the province itself**, not in a floating card outside
  // it: three centred lines (rank / name / value) whose horizontal middle is the
  // province's own centre, so the second line — the Thai name — lines up with the
  // province centre exactly, and whose bottom edge rests on the province's centre
  // line, so the block occupies the upper half of the province shape. The block
  // only moves when the province is too close to a core-rect edge (then it is
  // pulled inside) or when the platform's right-hand action rail would cover it
  // (then it shifts left by the minimum).
  //
  // Placement depends only on the static viewport and the province geometry, so
  // it is computed once per frame from the static inputs — the readouts cannot
  // jitter while they are shown, and a readout keeps the exact same spot from
  // the moment it appears to the last frame. Because every readout stays on
  // screen, the blocks are placed in reveal order and each one knows the rects
  // already taken: when two small neighbours collide, the later one steps down
  // instead of printing on top of the earlier one.
  const ordered = useMemo(() => {
    const byIdFeature = new Map(renderedFeatures.map((feature) => [feature.id, feature]));
    const out: {key: string; datum: RankingDatum; revealAt: number; placement: ReturnType<typeof placeLabel>}[] = [];
    const occupied: LabelRect[] = [];
    for (const {datum, revealAt} of revealed) {
      const feature = byIdFeature.get(idKey(datum.provinceId));
      if (!feature) continue;
      const placement = placeLabel({
        bounds: {
          x0: feature.bounds[0][0],
          y0: feature.bounds[0][1],
          x1: feature.bounds[1][0],
          y1: feature.bounds[1][1],
        },
        panelBounds: framing.labelRect,
        keepOut: framing.keepOutRect ?? null,
        occupied,
      });
      occupied.push(placement.panelRect);
      out.push({key: idKey(datum.provinceId), datum, revealAt, placement});
    }
    return out;
  }, [revealed, renderedFeatures, framing]);

  return <svg
    viewBox={`0 0 ${framing.stage.width} ${framing.stage.height}`}
    width={framing.stage.width}
    height={framing.stage.height}
    style={{overflow: 'hidden'}}
  >
    <g>
      {renderedFeatures.map(({id, path: featurePath}) => {
        const datum = byId.get(id);
        const revealed = visibleIdSet.has(id) && datum !== undefined;
        const isActive = active !== undefined && idKey(active.provinceId) === id;
        // Land is white on a bright sea; every province keeps a hairline border
        // so the country never reads as one blank shape. Revealed provinces get
        // a white border instead, which separates two touching rank colours.
        const fill = revealed ? fillForRank(datum.rank) : theme.provinceBase;
        const stroke = isActive
          ? theme.accentInk
          : revealed
            ? theme.provinceEdge
            : theme.provinceBorder;
        return <path key={id} d={featurePath} fill={fill} fillOpacity={1} stroke={stroke} strokeOpacity={revealed ? 0.95 : 0.85} strokeWidth={isActive ? 3.2 : 1.15} />;
      })}
    </g>
    {activeFeature ? <path d={activeFeature.path} fill="none" stroke={theme.accent} strokeWidth="10" strokeOpacity={0.2 * activeProgress} /> : null}
    {/* Every revealed province keeps its readout: the narration moves on, the
        numbers stay. They are drawn in reveal order, so the most recent one sits
        on top where two small provinces' blocks meet. */}
    {ordered.map(({key, datum, revealAt, placement}) => {
      const progress = spring({frame: frame - revealAt, fps, config: {damping: 15, stiffness: 130}});
      if (progress <= 0) return null;
      // The block's horizontal middle — the province centre unless the rail or a
      // core-rect edge forced a shift. Every line is centred on it, so the Thai
      // name (second line) is the line that sits exactly over the province.
      const textX = placement.panel[0] + LABEL_WIDTH / 2;
      const textY = placement.panel[1];
      return <g key={key} opacity={Math.min(1, progress)} textAnchor="middle">
        <text x={textX} y={textY + LABEL_RANK_Y} fill={theme.accentInk} fontSize="22" fontWeight="700" letterSpacing="3" {...HALO}>
          RANK {String(datum.rank).padStart(2, '0')}
        </text>
        <text x={textX} y={textY + LABEL_NAME_Y} fill={theme.text} fontSize="32" fontWeight="700" {...HALO}>
          {datum.provinceTh || datum.provinceEn}
        </text>
        <text x={textX} y={textY + LABEL_VALUE_Y} fill={theme.mutedText} fontSize="22" {...HALO}>
          {datum.valueLabel ?? datum.value.toLocaleString()} {project.unit}
        </text>
      </g>;
    })}
  </svg>;
};
