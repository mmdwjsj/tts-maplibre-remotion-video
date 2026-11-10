import React, {useMemo} from 'react';
import {geoPath} from 'd3-geo';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import type {ProjectData, RankingDatum, ThailandGeoJson} from '../../types';
import {theme} from '../../config/theme';
import {createProjection} from '../../framing/resolveViewport';
import type {FramingRect, FramingViewport} from '../../framing/resolveViewport';
import {
  LABEL_BASELINE,
  LABEL_BOX,
  LABEL_FONT_SIZE,
  LABEL_HALO,
  applyLabelOffset,
  normalizeLabelOffsetMap,
  placeLabel,
} from '../layout/labelPlacement';
import type {LabelRect} from '../layout/labelPlacement';

type Props = {
  geojson: ThailandGeoJson;
  project: ProjectData;
  /**
   * Every ranked province, with both beats of its readout: `revealAt` (its name
   * starts being voiced) and `hideAt` (its line ends). The list is the *whole*
   * ranking, not "what has been announced so far" — placement must not change
   * when a higher rank joins, and the closing shot needs the complete set.
   */
  readouts: {datum: RankingDatum; revealAt: number; hideAt: number}[];
  active?: RankingDatum;
  /** Frame the highlight animation starts — the instant the province is named. */
  revealStart: number;
  /**
   * Frame every readout comes back **together**: the instant the last line has
   * been spoken, plus one silent beat (`timeline.finaleAt`). The pause is what
   * keeps the closing shot from blinking — the readouts leave, the map holds
   * empty, then the complete ranking settles back in.
   */
  allAt: number;
  /**
   * Static viewport resolved once for the whole video. The map never re-derives
   * centre/zoom per frame, so the camera is identical in every frame.
   */
  framing: FramingViewport;
};

const LABEL_WIDTH = LABEL_BOX.width;

/**
 * Frames a readout takes to fade away once its line has been spoken. Short and
 * linear on purpose: the narration has already moved on, so the numbers must not
 * linger over the next province.
 */
const LABEL_FADE_OUT_FRAMES = 8;

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
  stroke: LABEL_HALO.color,
  strokeWidth: LABEL_HALO.width,
  strokeLinejoin: 'round' as const,
  paintOrder: 'stroke' as const,
};

/**
 * Baselines and font sizes come straight from `labelPlacement` — the same module
 * the server-side audit and the web preview read, so the three never drift apart.
 * The first line reads `NO.02` (it used to read a "rank" word + number).
 */
const rankLabel = (rank: number): string => `NO.${String(rank).padStart(2, '0')}`;

export const ThailandMap: React.FC<Props> = ({geojson, project, readouts, active, revealStart, allAt, framing}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const projection = useMemo(() => createProjection(framing), [framing]);
  const path = useMemo(() => geoPath(projection), [projection]);
  const byId = useMemo(
    () => new Map(project.rankings.map((ranking) => [idKey(ranking.provinceId), ranking])),
    [project.rankings],
  );
  // 填充色只跟「已经念到」有关：解说走到第几府，地图就点亮到第几府。读数的
  // 显隐另外算（解说结束就淡出、全部说完再一起回来），两者不再共用一份列表。
  const litIdSet = useMemo(
    () =>
      new Set(
        readouts
          .filter(({revealAt}) => frame >= revealAt)
          .map(({datum}) => idKey(datum.provinceId)),
      ),
    [readouts, frame],
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
  // province's own centre, and whose **second line — the Thai name — is centred
  // vertically on the province centre** (`block top = province centre − 47.55`,
  // i.e. the name baseline minus 0.35em). That alignment is the one rule
  // placement never breaks: a province too small for the block (Bangkok is
  // 83x56px against a 92px block) spills evenly above and below its centre
  // instead of being shoved down into the sea. The block
  // only moves when the province is too close to a core-rect edge (pulled
  // inside), when the platform's right-hand action rail would cover it (minimum
  // horizontal shift), or when a resident neighbour's block already occupies the
  // spot (up to one block height, smallest shift that clears).
  //
  // Placement depends only on the static viewport and the province geometry, so
  // it is computed once per frame from the static inputs — the readouts cannot
  // jitter, and a readout keeps the exact same spot from the moment it appears to
  // the last frame. Blocks are placed in **rank order**, not reveal order: the
  // narration counts down (5 → 1) while the server-side safe-area audit walks the
  // ranking (1 → 5), so rank order is the only sequence both sides agree on.
  //
  // A manual offset (dragged in the web preview) is layered on top of the
  // automatic result, never instead of it: the block is still centred on the
  // province first, then nudged by the recorded (dx, dy). Offsets outside
  // `MAX_MANUAL_OFFSET_PX` are dropped by `applyLabelOffset`, so a wild drag in
  // the preview can never survive into the MP4 — it falls back to auto layout.
  const manualOffsets = useMemo(
    () => normalizeLabelOffsetMap(project.labelOffsets),
    [project.labelOffsets],
  );
  const placements = useMemo(() => {
    const byIdFeature = new Map(renderedFeatures.map((feature) => [feature.id, feature]));
    const result = new Map<string, ReturnType<typeof placeLabel>>();
    const occupied: LabelRect[] = [];
    const inRankOrder = [...readouts].sort((a, b) => a.datum.rank - b.datum.rank);
    for (const {datum} of inRankOrder) {
      const key = idKey(datum.provinceId);
      const feature = byIdFeature.get(key);
      if (!feature) continue;
      // The avoidance skeleton is built from **automatic** rects only, then the
      // manual nudge is layered on: dragging one readout must not push its
      // neighbours around (a collision the user creates is reported by the
      // audit, not silently resolved by moving somebody else).
      const auto = placeLabel({
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
      occupied.push(auto.panelRect);
      const placement = applyLabelOffset(auto, manualOffsets[key]);
      result.set(key, placement);
    }
    return result;
  }, [readouts, renderedFeatures, framing, manualOffsets]);

  return <svg
    viewBox={`0 0 ${framing.stage.width} ${framing.stage.height}`}
    width={framing.stage.width}
    height={framing.stage.height}
    style={{overflow: 'hidden'}}
  >
    <g>
      {renderedFeatures.map(({id, path: featurePath}) => {
        const datum = byId.get(id);
        const lit = litIdSet.has(id) && datum !== undefined;
        const isActive = active !== undefined && idKey(active.provinceId) === id;
        // Land is white on a bright sea; every province keeps a hairline border
        // so the country never reads as one blank shape. Revealed provinces get
        // a white border instead, which separates two touching rank colours.
        const fill = lit ? fillForRank(datum.rank) : theme.provinceBase;
        const stroke = isActive
          ? theme.accentInk
          : lit
            ? theme.provinceEdge
            : theme.provinceBorder;
        return <path key={id} d={featurePath} fill={fill} fillOpacity={1} stroke={stroke} strokeOpacity={lit ? 0.95 : 0.85} strokeWidth={isActive ? 3.2 : 1.15} />;
      })}
    </g>
    {activeFeature ? <path d={activeFeature.path} fill="none" stroke={theme.accent} strokeWidth="10" strokeOpacity={0.2 * activeProgress} /> : null}
    {/* Readout lifetime: a province's numbers sit on it only while its own line
        is being voiced, then they fade away — the narration stays on one place
        at a time. Once the last line is spoken (`allAt`) the whole ranking comes
        back in one go and stays for the closing hold. Positions themselves come
        from the rank-ordered placement map, so a readout that leaves and returns
        lands on the exact same pixels. */}
    {readouts.map(({datum, revealAt, hideAt}) => {
      const key = idKey(datum.provinceId);
      const placement = placements.get(key);
      if (!placement) return null;
      // Finished narration: every readout re-enters together, ranked province by
      // ranked province, so the closing shot is the complete ranking. The entry
      // starts one silent beat after the last fade (`allAt = finalStart + pause`)
      // and uses a softer spring than the per-province pop, so the whole set
      // settles in instead of snapping back the frame after it vanished.
      const inFinale = frame >= allAt;
      let opacity: number;
      if (inFinale) {
        opacity = spring({frame: frame - allAt, fps, config: {damping: 20, stiffness: 85}});
      } else {
        if (frame < revealAt) return null;
        const enter = spring({frame: frame - revealAt, fps, config: {damping: 15, stiffness: 130}});
        // The fade ends on `hideAt` — for the last province that is `finalStart`,
        // a whole pause before the finale entry, so the map goes quiet in
        // between instead of blinking from 0 to 1 within a frame.
        const leave = interpolate(frame, [hideAt - LABEL_FADE_OUT_FRAMES, hideAt], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        opacity = Math.min(1, enter) * leave;
      }
      if (opacity <= 0.001) return null;
      // The block's horizontal middle — the province centre unless the rail or a
      // core-rect edge forced a shift. Every line is centred on it, so the Thai
      // name (second line) is the line that sits exactly over the province.
      const textX = placement.panel[0] + LABEL_WIDTH / 2;
      const textY = placement.panel[1];
      return <g key={key} opacity={opacity} textAnchor="middle">
        <text x={textX} y={textY + LABEL_BASELINE.rank} fill={theme.text} fontSize={LABEL_FONT_SIZE.rank} fontWeight="700" letterSpacing="2" {...HALO}>
          {rankLabel(datum.rank)}
        </text>
        <text x={textX} y={textY + LABEL_BASELINE.name} fill={theme.text} fontSize={LABEL_FONT_SIZE.name} fontWeight="700" {...HALO}>
          {datum.provinceTh || datum.provinceEn}
        </text>
        <text x={textX} y={textY + LABEL_BASELINE.value} fill={theme.text} fontSize={LABEL_FONT_SIZE.value} fontWeight="700" {...HALO}>
          {datum.valueLabel ?? datum.value.toLocaleString()} {project.unit}
        </text>
      </g>;
    })}
  </svg>;
};
