import React, {useMemo} from 'react';
import {AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import geoData from '../data/thailand-provinces.geo.json';
import type {ProjectData, ThailandGeoJson} from '../types';
import {buildTimeline} from '../timeline/buildTimeline';
import {theme} from '../config/theme';
import {ThailandMap} from './components/ThailandMap';

export const ThailandRankingVideo: React.FC<{project: ProjectData}> = ({project}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const timeline = useMemo(() => buildTimeline(project), [project]);
  const activeIndex = findActiveSegmentIndex(timeline.segments, frame);
  const activeSegment = activeIndex === -1 ? undefined : timeline.segments[activeIndex];
  const visibleIds = useMemo(
    () => timeline.segments.slice(0, activeIndex + 1).map((segment) => segment.datum.provinceId),
    [activeIndex, timeline.segments],
  );
  const intro = spring({frame, fps, config: {damping: 18, stiffness: 90}});
  const zoom = activeSegment ? interpolate(frame, [activeSegment.start, activeSegment.start + 18, activeSegment.end], [1, 1.025, 1.008], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;

  return (
    <AbsoluteFill style={{background: theme.background, color: theme.text, fontFamily: 'Arial, Noto Sans Thai, sans-serif', overflow: 'hidden'}}>
      <div style={{position: 'absolute', inset: 0, background: `radial-gradient(circle at 50% 42%, ${theme.backgroundGlow} 0%, ${theme.background} 55%)`}} />
      <div style={{position: 'absolute', left: 58, right: 58, top: 62, height: 1, background: 'linear-gradient(90deg, transparent, rgba(41,229,210,.55), transparent)'}} />
      <header style={{position: 'absolute', top: 95, left: 72, right: 72, opacity: intro, transform: `translateY(${(1-intro)*18}px)`}}>
        <div style={{fontSize: 22, letterSpacing: 7, color: theme.accent}}>DATA / THAILAND</div>
        <h1 style={{fontSize: 54, lineHeight: 1.08, margin: '18px 0 8px', letterSpacing: 1}}>{project.title}</h1>
        <div style={{fontSize: 28, color: theme.mutedText}}>{project.subtitle}</div>
      </header>
      <div style={{position: 'absolute', top: 285, left: 0, width: 1080, height: 1510, transform: `scale(${zoom})`, transformOrigin: '50% 48%'}}>
        <ThailandMap geojson={geoData as ThailandGeoJson} project={project} visibleIds={visibleIds} active={activeSegment?.datum} activeStart={activeSegment?.start ?? 0} />
      </div>
      <footer style={{position: 'absolute', bottom: 48, left: 72, right: 72, display: 'flex', justifyContent: 'space-between', fontSize: 18, letterSpacing: 3, color: theme.mutedText}}>
        <span>PROVINCE DATA VISUALIZATION</span><span>{String(project.rankings.length).padStart(2,'0')} PROVINCES</span>
      </footer>
      {project.audioSrc ? <Audio src={staticFile(project.audioSrc)} /> : null}
    </AbsoluteFill>
  );
};

const findActiveSegmentIndex = (segments: ReturnType<typeof buildTimeline>['segments'], frame: number) => {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (frame < segment.start) high = middle - 1;
    else if (frame >= segment.end) low = middle + 1;
    else return middle;
  }
  return -1;
};
