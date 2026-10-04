import React, {useMemo} from 'react';
import {geoMercator, geoPath} from 'd3-geo';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import type {ProjectData, RankingDatum, ThailandGeoJson} from '../../types';
import {theme} from '../../config/theme';

type Props = {geojson: ThailandGeoJson; project: ProjectData; visibleIds: string[]; active?: RankingDatum; activeStart: number};

export const ThailandMap: React.FC<Props> = ({geojson, project, visibleIds, active, activeStart}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const projection = useMemo(() => geoMercator().fitExtent([[105, 35], [975, 1435]], geojson), [geojson]);
  const path = useMemo(() => geoPath(projection), [projection]);
  const byId = useMemo(() => new Map(project.rankings.map((r) => [r.provinceId, r])), [project.rankings]);
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds]);
  const renderedFeatures = useMemo(() => geojson.features.map((feature) => ({
    feature,
    id: feature.properties.provinceId,
    path: path(feature) ?? '',
    center: path.centroid(feature),
  })), [geojson.features, path]);
  const activeProgress = active ? spring({frame: frame-activeStart, fps, config: {damping: 15, stiffness: 130}}) : 0;
  const activeFeature = active ? renderedFeatures.find((feature) => feature.id === active.provinceId) : undefined;
  const center = activeFeature?.center ?? [540, 735];

  return <svg viewBox="0 0 1080 1480" width="1080" height="1480" style={{overflow: 'visible'}}>
    <g>
      {renderedFeatures.map(({id, path: featurePath}) => {
        const datum = byId.get(id);
        const visible = visibleIdSet.has(id);
        const isActive = active?.provinceId === id;
        const brightness = datum ? 0.48 + (project.rankings.length-datum.rank+1)/project.rankings.length*0.5 : 0;
        return <path key={id} d={featurePath} fill={visible ? theme.provinceActive : theme.provinceBase} fillOpacity={visible ? brightness : .9} stroke={visible ? theme.accent : theme.provinceBorder} strokeOpacity={visible ? .9 : .55} strokeWidth={isActive ? 3.2 : 1.15} />;
      })}
    </g>
    {activeFeature ? <path d={activeFeature.path} fill="none" stroke={theme.accent} strokeWidth="10" strokeOpacity={0.16 * activeProgress} /> : null}
    {active && activeFeature ? <g opacity={activeProgress} transform={`translate(${center[0]}, ${center[1]})`}>
      <circle r={interpolate(activeProgress,[0,1],[18,7])} fill={theme.accent}/>
      <line x1="10" y1="-5" x2="75" y2="-55" stroke={theme.accent} strokeWidth="2"/>
      <g transform="translate(75,-112)">
        <rect width="285" height="105" rx="8" fill={theme.panel} stroke={theme.panelBorder}/>
        <text x="18" y="29" fill={theme.accent} fontSize="18" fontWeight="700">RANK {String(active.rank).padStart(2,'0')}</text>
        <text x="18" y="61" fill={theme.text} fontSize="25" fontWeight="700">{active.provinceTh || active.provinceEn}</text>
        <text x="18" y="90" fill={theme.mutedText} fontSize="19">{active.valueLabel ?? active.value.toLocaleString()} {project.unit}</text>
      </g>
    </g> : null}
  </svg>;
};
