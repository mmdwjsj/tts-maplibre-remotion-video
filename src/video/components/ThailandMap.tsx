import React, {useMemo} from 'react';
import {geoPath} from 'd3-geo';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import type {ProjectData, RankingDatum, ThailandGeoJson} from '../../types';
import {theme} from '../../config/theme';
import {createProjection} from '../../framing/resolveViewport';
import type {FramingRect, FramingViewport} from '../../framing/resolveViewport';

type Props = {
  geojson: ThailandGeoJson;
  project: ProjectData;
  visibleIds: string[];
  active?: RankingDatum;
  activeStart: number;
  /**
   * Static viewport resolved once for the whole video. The map never re-derives
   * centre/zoom per frame, so the camera is identical in every frame.
   */
  framing: FramingViewport;
};

const LABEL_WIDTH = 285;
const LABEL_HEIGHT = 105;
const LABEL_OFFSET_X = 75;
const LABEL_OFFSET_Y = 112;
const EDGE_MARGIN = 10;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Ranking ids and GeoJSON ids are matched on a normalised key, never on names. */
const idKey = (value: unknown) => String(value ?? '').trim().toUpperCase();

/**
 * Places the floating label and its leader line.
 *
 * The anchor sits on the highlighted province (clamped into the framing rect);
 * the panel is placed inside `panelBounds`, the band the title header and the
 * footer do not cover. When the auto-framing leaves the highlighted province
 * outside the viewport, the marker sticks to the closest frame edge and points
 * towards the province: that is the off-frame direction hint, and it needs no
 * camera movement.
 */
const placeLabel = (cx: number, cy: number, rect: FramingRect, panelBounds: FramingRect) => {
  const anchorX = clamp(cx, rect.x0 + EDGE_MARGIN, rect.x1 - EDGE_MARGIN);
  const anchorY = clamp(cy, rect.y0 + EDGE_MARGIN, rect.y1 - EDGE_MARGIN);
  // The panel lives in `panelBounds`: the part of the canvas the header and the
  // footer do not cover, so framing can use the full height without burying the
  // label under an overlay.
  const panelMinX = panelBounds.x0 + EDGE_MARGIN;
  const panelMaxX = Math.max(panelMinX, panelBounds.x1 - LABEL_WIDTH - EDGE_MARGIN);
  const flip = anchorX + LABEL_OFFSET_X + LABEL_WIDTH > panelMaxX;
  const panelX = clamp(
    flip ? anchorX - LABEL_OFFSET_X - LABEL_WIDTH : anchorX + LABEL_OFFSET_X,
    panelMinX,
    panelMaxX,
  );
  const panelY = clamp(
    anchorY - LABEL_OFFSET_Y,
    panelBounds.y0,
    Math.max(panelBounds.y0, panelBounds.y1 - LABEL_HEIGHT),
  );
  const towardsRight = panelX >= anchorX;

  return {
    anchor: [anchorX, anchorY] as [number, number],
    panel: [panelX, panelY] as [number, number],
    line: [
      anchorX + 10 * (towardsRight ? 1 : -1),
      anchorY - 5,
      towardsRight ? panelX : panelX + LABEL_WIDTH,
      clamp(anchorY - 55, panelY, panelY + LABEL_HEIGHT),
    ] as [number, number, number, number],
  };
};

export const ThailandMap: React.FC<Props> = ({geojson, project, visibleIds, active, activeStart, framing}) => {
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
  const activeProgress = active ? spring({frame: frame-activeStart, fps, config: {damping: 15, stiffness: 130}}) : 0;
  const activeFeature = active
    ? renderedFeatures.find((feature) => feature.id === idKey(active.provinceId))
    : undefined;
  const label = activeFeature
    ? placeLabel(
        activeFeature.center[0],
        activeFeature.center[1],
        framing.rect,
        framing.labelRect,
      )
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
        const visible = visibleIdSet.has(id);
        const isActive = active !== undefined && idKey(active.provinceId) === id;
        const brightness = datum ? 0.48 + (project.rankings.length-datum.rank+1)/project.rankings.length*0.5 : 0;
        return <path key={id} d={featurePath} fill={visible ? theme.provinceActive : theme.provinceBase} fillOpacity={visible ? brightness : .9} stroke={visible ? theme.accent : theme.provinceBorder} strokeOpacity={visible ? .9 : .55} strokeWidth={isActive ? 3.2 : 1.15} />;
      })}
    </g>
    {activeFeature ? <path d={activeFeature.path} fill="none" stroke={theme.accent} strokeWidth="10" strokeOpacity={0.16 * activeProgress} /> : null}
    {active && label ? <g opacity={activeProgress}>
      <circle cx={label.anchor[0]} cy={label.anchor[1]} r={interpolate(activeProgress,[0,1],[18,7])} fill={theme.accent}/>
      <line x1={label.line[0]} y1={label.line[1]} x2={label.line[2]} y2={label.line[3]} stroke={theme.accent} strokeWidth="2"/>
      <g transform={`translate(${label.panel[0]}, ${label.panel[1]})`}>
        <rect width={LABEL_WIDTH} height={LABEL_HEIGHT} rx="8" fill={theme.panel} stroke={theme.panelBorder}/>
        <text x="18" y="29" fill={theme.accent} fontSize="18" fontWeight="700">RANK {String(active.rank).padStart(2,'0')}</text>
        <text x="18" y="61" fill={theme.text} fontSize="25" fontWeight="700">{active.provinceTh || active.provinceEn}</text>
        <text x="18" y="90" fill={theme.mutedText} fontSize="19">{active.valueLabel ?? active.value.toLocaleString()} {project.unit}</text>
      </g>
    </g> : null}
  </svg>;
};
