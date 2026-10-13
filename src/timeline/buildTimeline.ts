import { animation } from "../config/theme";
import type { ProjectData, RankingDatum } from "../types";

/**
 * A continuous block of the video timeline.
 * `activeStart..activeEnd` is the reveal window of the highlighted province,
 * `activeEnd..end` is the trailing silence where the previous province stays lit.
 */
export type TimelineSegment = {
  key: string;
  datum?: RankingDatum;
  start: number;
  activeStart: number;
  activeEnd: number;
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

const toFrames = (seconds: number, fps: number) =>
  Math.round(Math.max(0, seconds) * fps);

/** The spoken countdown reveals the lowest rank first and #1 last. */
const sortByRevealOrder = (rankings: RankingDatum[]) =>
  [...rankings].sort((a, b) => b.rank - a.rank);

/**
 * Follows the synthesized audio exactly: each segment's start, duration and
 * trailing silence come from the real audio, so the map highlight stays in sync
 * with the narration. Boundaries are rounded from absolute seconds (never
 * accumulated from rounded deltas) to avoid frame drift over long videos.
 */
const buildFromAudioSegments = (
  project: ProjectData,
  fps: number,
): VideoTimeline => {
  const byRank = new Map(
    sortByRevealOrder(project.rankings).map((datum) => [datum.rank, datum]),
  );
  const segments: TimelineSegment[] = [];
  let previousSeconds = 0;
  let previousFrame = 0;

  (project.audioSegments ?? []).forEach((segment, index) => {
    const activeSeconds = Math.max(0, segment.duration);
    const gapSeconds = Math.max(0, segment.gapAfter ?? 0);
    const start = previousFrame;
    const activeEnd = Math.max(
      start + 1,
      toFrames(previousSeconds + activeSeconds, fps),
    );
    const end = Math.max(
      activeEnd,
      toFrames(previousSeconds + activeSeconds + gapSeconds, fps),
    );

    segments.push({
      key: `${segment.type}-${segment.rank ?? "intro"}-${index}`,
      datum:
        segment.type === "ranking" && segment.rank !== undefined
          ? byRank.get(segment.rank)
          : undefined,
      start,
      activeStart: start,
      activeEnd,
      duration: activeEnd - start,
      end,
    });

    previousSeconds += activeSeconds + gapSeconds;
    previousFrame = end;
  });

  const finalStart = toFrames(previousSeconds, fps);

  return {
    introFrames: 0,
    segments,
    finalStart,
    // Round up so the rendered video is never shorter than the audio track.
    totalFrames: Math.max(
      previousFrame,
      Math.ceil((previousSeconds + (project.finalHoldDuration ?? 0)) * fps),
    ),
  };
};

/**
 * Offline fallback used by Remotion Studio / CLI when no audio segment metadata
 * is available: every province gets its nominal `narrationDuration`.
 */
const buildFromNarrationDurations = (
  project: ProjectData,
  fps: number,
): VideoTimeline => {
  const introFrames = toFrames(project.introDuration ?? animation.introDuration, fps);
  let previousSeconds = 0;
  let previousFrame = introFrames;

  const segments = sortByRevealOrder(project.rankings).map(
    (datum): TimelineSegment => {
      const activeSeconds =
        datum.narrationDuration ?? animation.defaultSegmentDuration;
      const start = previousFrame;
      const activeEnd = Math.max(
        start + 1,
        introFrames + toFrames(previousSeconds + activeSeconds, fps),
      );

      previousSeconds += activeSeconds;
      previousFrame = activeEnd;

      return {
        key: `rank-${datum.rank}`,
        datum,
        start,
        activeStart: start,
        activeEnd,
        duration: activeEnd - start,
        end: activeEnd,
      };
    },
  );

  const holdSeconds = project.finalHoldDuration ?? animation.finalHoldDuration;

  return {
    introFrames,
    segments,
    finalStart: previousFrame,
    totalFrames: Math.max(
      previousFrame,
      introFrames + Math.ceil((previousSeconds + holdSeconds) * fps),
    ),
  };
};

export const buildTimeline = (project: ProjectData): VideoTimeline => {
  const cached = timelineCache.get(project);
  if (cached) return cached;

  const fps = project.fps ?? animation.fps;
  const timeline = project.audioSegments?.length
    ? buildFromAudioSegments(project, fps)
    : buildFromNarrationDurations(project, fps);

  timelineCache.set(project, timeline);
  return timeline;
};
