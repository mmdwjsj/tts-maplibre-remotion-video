// The `.ts` extension is deliberate: it keeps this module loadable straight
// from Node (type stripping) so `scripts/timeline/timeline.test.mjs` can test
// the real implementation instead of a copy.
import { animation } from "../config/theme.ts";
import type { AudioSegment, ProjectData, RankingDatum } from "../types";

/**
 * Which piece of a narrated line a segment covers.
 *
 * A ranking line is spoken in two pieces — the rank announcement
 * (`อันดับ 3`) and then the province itself — and the map lights the province
 * when the *second* piece starts. `line` is a whole line in one piece: it is
 * what render props written before the split carry, and what a line that says
 * nothing about ranks would fall back to.
 */
export type TimelinePart = "opening" | "rank" | "name" | "line";

/**
 * A continuous block of the video timeline.
 *
 * The narration occupies `[start, start + duration)` and `revealAt` is the
 * instant the map reacts to it. Revealing a province when its *name* is voiced
 * (rather than when its line begins, or when the whole line has been read out)
 * is what keeps the highlight on the voice: the rank is announced first, the
 * province lights up as it is being named.
 */
export type TimelineSegment = {
  key: string;
  /** The province this segment belongs to; absent on `opening` and `rank`. */
  datum?: RankingDatum;
  part: TimelinePart;
  /** Frame the narration for this piece starts. */
  start: number;
  /** Spoken length in frames; the narration occupies `[start, start + duration)`. */
  duration: number;
  /**
   * Frame the province lights up.
   *
   * - `name`: `start` — the province appears as its name is voiced.
   * - `rank` / `opening`: the end of the narration (nothing to light).
   * - `line`: the end of the narration, because the name is inside it.
   */
  revealAt: number;
  /** Frame the segment ends, trailing silence included. */
  end: number;
};

/**
 * The intro camera move, in frames.
 *
 * The video opens on the whole country (title card) and flies into the resolved
 * framing while the opening line is spoken: `start` is the instant the opening
 * narration begins, `end` the instant it finishes. Camera and voice therefore
 * share one window — the move never overlaps the first ranking line, so the map
 * is already standing still when the first province lights up.
 *
 * `start === end` means "no move": there is no opening line (or it has no
 * measurable length), so the camera simply sits on the target framing from frame
 * 0, exactly like before this feature existed.
 */
export type CameraMove = {
  start: number;
  end: number;
};

export type VideoTimeline = {
  introFrames: number;
  /**
   * Frame at which the title header must be gone, `0` when it should stay.
   *
   * The header only introduces the video, so it fades out the moment the opening
   * line has been spoken — after that it would just sit on top of the map. With
   * no opening line there is nothing to finish, so the header stays.
   */
  titleEndFrames: number;
  /** Intro camera move: whole country → resolved framing, across the opening line. */
  camera: CameraMove;
  segments: TimelineSegment[];
  finalStart: number;
  totalFrames: number;
};

/**
 * Share of a line taken by the rank announcement (`อันดับ 3 `). The audio path
 * measures the real split from the real text; the offline path has no text, so
 * it uses the share the Thai template produces (9 of 45 characters for a typical
 * line).
 */
export const RANK_PREFIX_SHARE = 0.2;

const timelineCache = new WeakMap<ProjectData, VideoTimeline>();

const toFrames = (seconds: number, fps: number) =>
  Math.round(Math.max(0, seconds) * fps);

/** The spoken countdown reveals the lowest rank first and #1 last. */
const sortByRevealOrder = (rankings: RankingDatum[]) =>
  [...rankings].sort((a, b) => b.rank - a.rank);

const partOf = (segment: AudioSegment): TimelinePart => {
  if (segment.type === "opening") return "opening";
  if (segment.part === "rank") return "rank";
  if (segment.part === "name") return "name";
  return "line";
};

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
    const spokenSeconds = Math.max(0, segment.duration);
    const gapSeconds = Math.max(0, segment.gapAfter ?? 0);
    const part = partOf(segment);
    const start = previousFrame;
    const narrated = Math.max(
      start + 1,
      toFrames(previousSeconds + spokenSeconds, fps),
    );
    const end = Math.max(
      narrated,
      toFrames(previousSeconds + spokenSeconds + gapSeconds, fps),
    );
    const datum =
      part === "rank" || part === "opening" || segment.rank === undefined
        ? undefined
        : byRank.get(segment.rank);

    segments.push({
      key: `${segment.type}-${segment.rank ?? "intro"}-${part}-${index}`,
      datum,
      part,
      start,
      duration: narrated - start,
      // A province lights the moment its name starts being voiced: the rank has
      // just been read out and the voice is moving onto the province itself.
      revealAt: part === "name" ? start : narrated,
      end,
    });

    previousSeconds += spokenSeconds + gapSeconds;
    previousFrame = end;
  });

  const finalStart = toFrames(previousSeconds, fps);
  const opening =
    segments[0] && segments[0].part === "opening" ? segments[0] : undefined;

  return {
    introFrames: 0,
    titleEndFrames: opening ? opening.revealAt : 0,
    // The camera rides exactly on the opening line: it starts the frame the
    // welcome line starts and lands the frame it ends (an `opening` segment has
    // nothing to reveal, so `revealAt` is the end of its narration).
    camera: opening
      ? {start: opening.start, end: opening.revealAt}
      : {start: 0, end: 0},
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
 * is available: every province gets its nominal `narrationDuration`, split into
 * the same rank-then-name pair so the studio preview keeps the same rhythm.
 */
const buildFromNarrationDurations = (
  project: ProjectData,
  fps: number,
): VideoTimeline => {
  const introFrames = toFrames(project.introDuration ?? animation.introDuration, fps);
  const segments: TimelineSegment[] = [];
  let previousSeconds = 0;
  let previousFrame = introFrames;

  sortByRevealOrder(project.rankings).forEach((datum) => {
    const lineSeconds =
      datum.narrationDuration ?? animation.defaultSegmentDuration;
    const rankSeconds = lineSeconds * RANK_PREFIX_SHARE;
    const nameSeconds = lineSeconds - rankSeconds;
    const pieces: Array<{part: TimelinePart; seconds: number; datum?: RankingDatum}> = [
      {part: "rank", seconds: rankSeconds},
      {part: "name", seconds: nameSeconds, datum},
    ];

    pieces.forEach((piece) => {
      const start = previousFrame;
      const narrated = Math.max(
        start + 1,
        introFrames + toFrames(previousSeconds + piece.seconds, fps),
      );

      segments.push({
        key: `rank-${datum.rank}-${piece.part}`,
        datum: piece.datum,
        part: piece.part,
        start,
        duration: narrated - start,
        revealAt: piece.part === "name" ? start : narrated,
        end: narrated,
      });

      previousSeconds += piece.seconds;
      previousFrame = narrated;
    });
  });

  const holdSeconds = project.finalHoldDuration ?? animation.finalHoldDuration;

  return {
    introFrames,
    // The silent intro card is the only thing before the first reveal here, so
    // the header lives exactly as long as it does.
    titleEndFrames: introFrames,
    // No audio to follow: the move fills the silent intro card instead, so the
    // Remotion Studio preview shows the same fly-in the MP4 does.
    camera: {start: 0, end: introFrames},
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

/**
 * Index of the segment the map currently reacts to: the last one whose
 * `revealAt` has been reached. `-1` means nothing is lit yet, either because the
 * video has not started or because only the opening line has played.
 *
 * A `rank` piece shares its `revealAt` with the `name` piece that follows it, so
 * during the announcement the index still points at the *previous* province —
 * and the moment the name starts it slides onto the new one.
 */
export const findRevealedSegmentIndex = (
  segments: TimelineSegment[],
  frame: number,
): number => {
  let revealed = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].revealAt > frame) break;
    revealed = index;
  }
  return revealed;
};
