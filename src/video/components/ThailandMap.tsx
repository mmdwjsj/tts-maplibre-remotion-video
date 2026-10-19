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
