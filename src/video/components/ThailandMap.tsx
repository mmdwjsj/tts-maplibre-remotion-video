import React, {useMemo} from 'react';
import {geoPath} from 'd3-geo';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import type {ProjectData, RankingDatum, ThailandGeoJson} from '../../types';
import {theme} from '../../config/theme';
import {createProjection} from '../../framing/resolveViewport';
import type {FramingRect, FramingViewport} from '../../framing/resolveViewport';
import {LABEL_BOX, placeLabel} from '../layout/labelPlacement';

type Props = {
  geojson: ThailandGeoJson;
  project: ProjectData;
  visibleIds: string[];
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
const LABEL_HEIGHT = LABEL_BOX.height;

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

export const ThailandMap: React.FC<Props> = ({geojson, project, visibleIds, active, revealStart, framing}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const projection = useMemo(() => createProjection(framing), [framing]);
  const path = useMemo(() => geoPath(projection), [projection]);
  const byId = useMemo(
    () => new Map(project.rankings.map((ranking) => [idKey(ranking.provinceId), ranking])),
    [project.rankings],
  );
  const visibleIdSet = useMemo(() => new Set(visibleIds.map(idKey)), [visibleIds]);
  const renderedFeatures = useMemo(() => geojson.features.map((feature) => ({
    feature,
    id: idKey(feature.properties.provinceId),
    path: path(feature) ?? '',
    center: path.centroid(feature),
  })), [geojson.features, path]);
  const activeProgress = active ? spring({frame: frame-revealStart, fps, config: {damping: 15, stiffness: 130}}) : 0;
  const activeFeature = active
    ? renderedFeatures.find((feature) => feature.id === idKey(active.provinceId))
    : undefined;
  // The anchor may sit anywhere the base map reaches (it marks a real province);
  // the panel itself is confined to the safe label area and is pushed out of the
  // platform's right-hand action rail when one is configured.
  const label = activeFeature
    ? placeLabel({
        cx: activeFeature.center[0],
        cy: activeFeature.center[1],
        rect: framing.mapRect ?? framing.rect,
        panelBounds: framing.labelRect,
        keepOut: framing.keepOutRect ?? null,
      })
    : null;

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
    {active && label ? <g opacity={activeProgress}>
      <circle cx={label.anchor[0]} cy={label.anchor[1]} r={interpolate(activeProgress,[0,1],[18,7])} fill={theme.accent}/>
      <line x1={label.line[0]} y1={label.line[1]} x2={label.line[2]} y2={label.line[3]} stroke={theme.accent} strokeWidth="2"/>
      <g transform={`translate(${label.panel[0]}, ${label.panel[1]})`}>
        <rect width={LABEL_WIDTH} height={LABEL_HEIGHT} rx="8" fill={theme.panel} stroke={theme.panelBorder}/>
        {/* Colour chip doubled as the rank tag: it shows the exact swatch the
            province is painted with, so the label and the map cannot disagree. */}
        <rect x="18" y="16" width="8" height="18" rx="2" fill={fillForRank(active.rank)}/>
        <text x="34" y="31" fill={theme.accentInk} fontSize="18" fontWeight="700">RANK {String(active.rank).padStart(2,'0')}</text>
        <text x="18" y="61" fill={theme.text} fontSize="25" fontWeight="700">{active.provinceTh || active.provinceEn}</text>
        <text x="18" y="90" fill={theme.mutedText} fontSize="19">{active.valueLabel ?? active.value.toLocaleString()} {project.unit}</text>
      </g>
    </g> : null}
  </svg>;
};
