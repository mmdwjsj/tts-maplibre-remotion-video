import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import geoData from "../data/thailand-provinces.geo.json";
import type { ProjectData, ThailandGeoJson } from "../types";
import { buildTimeline } from "../timeline/buildTimeline";
import { theme } from "../config/theme";
import { ThailandMap } from "./components/ThailandMap";

// The layout is authored on a 1080x1920 portrait canvas and then uniformly
// scaled, so square and landscape compositions stay proportional instead of
// breaking the absolute positioning.
const DESIGN_WIDTH = 1080;
const DESIGN_HEIGHT = 1920;

export const ThailandRankingVideo: React.FC<{ project: ProjectData }> = ({
  project,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const timeline = useMemo(() => buildTimeline(project), [project]);
  const activeIndex = findActiveSegmentIndex(timeline.segments, frame);
  const activeSegment =
    activeIndex === -1 ? undefined : timeline.segments[activeIndex];
  const visibleIds = useMemo(
    () =>
      timeline.segments
        .slice(0, activeIndex + 1)
        .map((segment) => segment.datum?.provinceId)
        .filter((provinceId): provinceId is string => Boolean(provinceId)),
    [activeIndex, timeline.segments],
  );
  const intro = spring({ frame, fps, config: { damping: 18, stiffness: 90 } });
  const zoom = revealZoom(frame, activeSegment);
  const scale = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);

  return (
    <AbsoluteFill
      style={{
        background: theme.background,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 50% 42%, ${theme.backgroundGlow} 0%, ${theme.background} 55%)`,
        }}
      />
      <div
        style={{
          position: "relative",
          width: DESIGN_WIDTH,
          height: DESIGN_HEIGHT,
          flexShrink: 0,
          color: theme.text,
          fontFamily: "Arial, Noto Sans Thai, sans-serif",
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 58,
            right: 58,
            top: 62,
            height: 1,
            background:
              "linear-gradient(90deg, transparent, rgba(41,229,210,.55), transparent)",
          }}
        />
        <header
          style={{
            position: "absolute",
            top: 95,
            left: 72,
            right: 72,
            opacity: intro,
            transform: `translateY(${(1 - intro) * 18}px)`,
          }}
        >
          {/* <div style={{ fontSize: 22, letterSpacing: 7, color: theme.accent }}>
            DATA / THAILAND
          </div> */}
          <h1
            style={{
              fontSize: 54,
              lineHeight: 1.08,
              margin: "18px 0 8px",
              letterSpacing: 1,
            }}
          >
            {project.title}
          </h1>
          <div style={{ fontSize: 28, color: theme.mutedText }}>
            {project.subtitle}
          </div>
        </header>
        <div
          style={{
            position: "absolute",
            top: 285,
            left: 0,
            width: 1080,
            height: 1510,
            transform: `scale(${zoom})`,
            transformOrigin: "50% 48%",
          }}
        >
          <ThailandMap
            geojson={geoData as ThailandGeoJson}
            project={project}
            visibleIds={visibleIds}
            active={activeSegment?.datum}
            activeStart={activeSegment?.activeStart ?? 0}
          />
        </div>
        <footer
          style={{
            position: "absolute",
            bottom: 48,
            left: 72,
            right: 72,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 18,
            letterSpacing: 3,
            color: theme.mutedText,
          }}
        >
          <span>PROVINCE DATA VISUALIZATION</span>
          <span>
            {String(project.rankings.length).padStart(2, "0")} PROVINCES
          </span>
        </footer>
      </div>
      {project.audioSrc ? <Audio src={staticFile(project.audioSrc)} /> : null}
    </AbsoluteFill>
  );
};

/**
 * Slow push-in while a province is being revealed, then hold the gentle zoom
 * through the trailing silence so the highlight does not pop back to 1.
 */
const revealZoom = (
  frame: number,
  segment?: ReturnType<typeof buildTimeline>["segments"][number],
) => {
  if (!segment || segment.activeEnd - segment.activeStart < 2) return 1;
  return interpolate(
    frame,
    [
      segment.activeStart,
      Math.min(segment.activeStart + 18, segment.activeEnd - 1),
      segment.activeEnd,
    ],
    [1, 1.025, 1.008],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
};

const findActiveSegmentIndex = (
  segments: ReturnType<typeof buildTimeline>["segments"],
  frame: number,
) => {
  if (!segments.length) return -1;
  // Before the first reveal nothing is lit yet.
  if (frame < segments[0].start) return -1;
  // After the last reveal we hold the final state instead of clearing the map.
  if (frame >= segments[segments.length - 1].end) return segments.length - 1;

  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (frame < segment.start) high = middle - 1;
    else if (frame >= segment.end) low = middle + 1;
    else return middle;
  }
  return segments.length - 1;
};
