import {animation} from '../config/theme';
import type {ProjectData, RankingDatum} from '../types';

export type TimelineSegment = {datum: RankingDatum; start: number; duration: number; end: number};
export type VideoTimeline = {introFrames: number; segments: TimelineSegment[]; finalStart: number; totalFrames: number};

const timelineCache = new WeakMap<ProjectData, VideoTimeline>();

export const buildTimeline = (project: ProjectData): VideoTimeline => {
  const cached = timelineCache.get(project);
  if (cached) return cached;

  const fps = project.fps ?? animation.fps;
  const introFrames = Math.round((project.introDuration ?? animation.introDuration) * fps);
  let cursor = introFrames;
  // The spoken countdown reveals the lowest rank first and #1 last.
  const revealOrder = [...project.rankings].sort((a, b) => b.rank - a.rank);
  const segments = revealOrder.map((datum) => {
    const duration = Math.round((datum.narrationDuration ?? animation.defaultSegmentDuration) * fps);
    const segment = {datum, start: cursor, duration, end: cursor + duration};
    cursor += duration;
    return segment;
  });
  const finalStart = cursor;
  const totalFrames = cursor + Math.round((project.finalHoldDuration ?? animation.finalHoldDuration) * fps);
  const timeline = {introFrames, segments, finalStart, totalFrames};
  timelineCache.set(project, timeline);
  return timeline;
};
