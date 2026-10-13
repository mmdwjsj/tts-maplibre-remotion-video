import { animation } from "../config/theme";
import type { ProjectData, RankingDatum } from "../types";

export type TimelineSegment = {
  datum: RankingDatum;
  start: number;
  duration: number;
  end: number;
};
export type VideoTimeline = {
  introFrames: number;
  segments: TimelineSegment[];
  finalStart: number;
  totalFrames: number;
};

const timelineCache = new WeakMap<ProjectData, VideoTimeline>();

export const buildTimeline = (project: ProjectData): VideoTimeline => {
  const cached = timelineCache.get(project);
  if (cached) return cached;

  const fps = project.fps ?? animation.fps;
  const introFrames = Math.round(
    (project.introDuration ?? animation.introDuration) * fps,
  );
  let cursor = introFrames;
  // The spoken countdown reveals the lowest rank first and #1 last.
  const revealOrder = [...project.rankings].sort((a, b) => b.rank - a.rank);
  const segments = revealOrder.map((datum, index) => {
    // Round absolute boundaries to avoid cumulative frame drift.
    const previousSeconds = revealOrder
      .slice(0, index)
      .reduce(
        (sum, item) =>
          sum + (item.narrationDuration ?? animation.defaultSegmentDuration),
        0,
      );

    const nextSeconds =
      previousSeconds +
      (datum.narrationDuration ?? animation.defaultSegmentDuration);

    const start = introFrames + Math.round(previousSeconds * fps);
    const end = introFrames + Math.round(nextSeconds * fps);
    const duration = end - start;

    const segment = { datum, start, duration, end };
    cursor = end;

    return segment;
  });
  const finalStart = cursor;
  const totalFrames =
    cursor +
    Math.round(
      (project.finalHoldDuration ?? animation.finalHoldDuration) * fps,
    );
  const timeline = { introFrames, segments, finalStart, totalFrames };
  timelineCache.set(project, timeline);
  return timeline;
};
