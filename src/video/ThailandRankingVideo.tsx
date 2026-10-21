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
import {
  buildTimeline,
  findRevealedSegmentIndex,
} from "../timeline/buildTimeline";
import { theme } from "../config/theme";
import { ThailandMap } from "./components/ThailandMap";
import { SafeAreaOverlay } from "./components/SafeAreaOverlay";
import { MAP_STAGE, blendViewport, resolveViewport } from "../framing/resolveViewport";
import {
  DEFAULT_SAFE_AREA_CONFIG,
  isDebugOverlayEnabled,
  resolveSafeArea,
} from "../safearea/safeArea";
import type { SafeRect } from "../safearea/safeArea";

// The layout is authored on a 1080x1920 portrait canvas and then uniformly
// scaled, so square and landscape compositions stay proportional instead of
// breaking the absolute positioning.
const DESIGN_WIDTH = 1080;
const DESIGN_HEIGHT = 1920;

// The map is the bottom layer and fills the entire canvas — `MAP_STAGE` is the
// container size in SVG user units, so the resolved viewport is always computed
// against the real container. Header and footer float above it; the header scrim
// keeps the title readable where a province or a leader line runs underneath.
// It is painted in the *sea* colour (not black): the palette is a light one —
// bright blue water, near-white land — so the header band reads as more water
// rather than as a dark bar, and the dark ink title keeps its contrast either
// way. There is deliberately **no footer scrim**: the footer carries no text, so
// a bottom gradient would only paint a band of deeper blue over the map.
const HEADER_SCRIM =
  "linear-gradient(180deg, rgba(47,169,225,0.96) 0%, rgba(47,169,225,0.9) 30%, rgba(47,169,225,0.5) 62%, rgba(47,169,225,0) 100%)";

/** Frames the title takes to fade away once the opening line has been spoken. */
const TITLE_FADE_FRAMES = 9;

/**
 * Re-maps a safe-area rectangle onto the design canvas.
 *
 * The safe area is authored on the canvas in `safe-area.config.json` (1080×1920
 * by default, same as the design canvas), so this is normally an identity map.
 * It only kicks in if someone changes the configured canvas size without
 * touching the layout, in which case the rectangles are scaled instead of
 * silently pointing at the wrong pixels.
 */
const toDesignRect = (
  rect: SafeRect,
  canvas: { width: number; height: number },
): SafeRect => {
  const sx = canvas.width > 0 ? DESIGN_WIDTH / canvas.width : 1;
  const sy = canvas.height > 0 ? DESIGN_HEIGHT / canvas.height : 1;
  if (sx === 1 && sy === 1) return rect;
  return {
    x0: rect.x0 * sx,
    y0: rect.y0 * sy,
    x1: rect.x1 * sx,
    y1: rect.y1 * sy,
  };
};

export const ThailandRankingVideo: React.FC<{ project: ProjectData }> = ({
  project,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const timeline = useMemo(() => buildTimeline(project), [project]);
  // A ranking line is two segments — the rank announcement and the province.
  // The province is lit at the instant its *name* starts being voiced, so while
  // the rank is read out the map still shows the province announced before it.
  const revealedIndex = findRevealedSegmentIndex(timeline.segments, frame);
  const activeSegment =
    revealedIndex === -1 ? undefined : timeline.segments[revealedIndex];
  const visibleIds = useMemo(
    () =>
      timeline.segments
        .slice(0, revealedIndex + 1)
        .map((segment) => segment.datum?.provinceId)
        .filter((provinceId): provinceId is string => Boolean(provinceId)),
    [revealedIndex, timeline.segments],
  );
  // Platform UI safe area. The server resolves it once per job (from the
  // platform config plus the publish-description tier) and writes it into the
  // render props, so the MP4 uses exactly the rectangles the preview showed.
  // Only when it is missing does the render fall back to the built-in defaults.
  const safeArea = useMemo(
    () =>
      project.safeArea ??
      resolveSafeArea(DEFAULT_SAFE_AREA_CONFIG, {
        platform: project.platform,
        description: project.publishDescription ?? "",
      }),
    [project],
  );
  const design = useMemo(() => {
    const canvas = safeArea.canvas;
    const sy = canvas.height > 0 ? DESIGN_HEIGHT / canvas.height : 1;
    const core = toDesignRect(safeArea.coreRect, canvas);
    return {
      core,
      label: toDesignRect(safeArea.labelRect, canvas),
      map: toDesignRect(safeArea.mapRect, canvas),
      keepOut: safeArea.interactiveGapRect
        ? toDesignRect(safeArea.interactiveGapRect, canvas)
        : null,
      topMargin: safeArea.margins.top * sy,
      bottomMargin: safeArea.margins.bottom * sy,
      rightMargin: DESIGN_WIDTH - core.x1,
    };
  }, [safeArea]);
  // Static camera: resolved once from the *complete* ranking set, before any
  // frame is rendered. The opening move (below) only *interpolates* between this
  // viewport and the whole-country one — it never re-fits anything per frame, so
  // the framing itself cannot drift while playing.
  // The platform safe area only feeds the fit rectangles — it never introduces
  // per-frame movement, so the camera is just as stable as before.
  const framingStage = useMemo(
    () => ({
      mapRect: design.map,
      labelRect: design.label,
      keepOutRect: design.keepOut,
    }),
    [design],
  );
  const framingTarget = useMemo(
    () =>
      resolveViewport(
        geoData as ThailandGeoJson,
        project.rankings.map((ranking) => ranking.provinceId),
        project.framing,
        MAP_STAGE,
        framingStage,
      ),
    [project, framingStage],
  );
  // Where the camera starts: the whole country, resolved through the very same
  // code path (`fitMode: 'full-country'`) instead of inventing a second
  // projection. Overriding only the mode keeps every other option (zoom limits,
  // safe area, presets) identical between the two ends of the move.
  const framingIntro = useMemo(
    () =>
      resolveViewport(
        geoData as ThailandGeoJson,
        project.rankings.map((ranking) => ranking.provinceId),
        { ...(project.framing ?? {}), fitMode: "full-country" as const },
        MAP_STAGE,
        framingStage,
      ),
    [project, framingStage],
  );
  // Intro camera move. The window comes straight from the timeline — it *is* the
  // opening line — so the camera and the voice start and stop together. Outside
  // the window the camera is pinned to one of the two resolved viewports, which
  // means a video without an opening line is pixel-identical to the old one.
  const cameraProgress =
    timeline.camera.end > timeline.camera.start
      ? interpolate(
          frame,
          [timeline.camera.start, timeline.camera.end],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
      : 1;
  const framing = useMemo(
    () =>
      !framingTarget.cameraMove || cameraProgress >= 1
        ? framingTarget
        : cameraProgress <= 0
          ? framingIntro
          : blendViewport(framingIntro, framingTarget, cameraProgress),
    [framingIntro, framingTarget, cameraProgress],
  );
  const intro = spring({ frame, fps, config: { damping: 18, stiffness: 90 } });
  // The title is only an intro card: it leaves the stage as soon as the opening
  // line has been spoken, so it never competes with the map for attention.
  const titleOpacity =
    timeline.titleEndFrames > 0
      ? interpolate(
          frame,
          [
            timeline.titleEndFrames - 4,
            timeline.titleEndFrames + TITLE_FADE_FRAMES,
          ],
          [1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
      : 1;
  const scale = Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT);

  // 标题字体自适应变小
  const getTitleFontSize = (title: string) => {
    const visualLength = Array.from(title.trim()).reduce((length, char) => {
      return length + (/[\u0000-\u00ff]/.test(char) ? 0.55 : 1);
    }, 0);

    if (visualLength <= 20) return 46;
    if (visualLength <= 30) return 42;
    if (visualLength <= 42) return 38;
    return 34;
  };

  const titleFontSize = getTitleFontSize(project.title);

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
        {/* Bottom layer: the map, full-bleed. It is painted first so the title
            header and the footer float above it instead of shrinking it. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: MAP_STAGE.width,
            height: MAP_STAGE.height,
            overflow: "hidden",
          }}
        >
          <ThailandMap
            geojson={geoData as ThailandGeoJson}
            project={project}
            visibleIds={visibleIds}
            active={activeSegment?.datum}
            revealStart={activeSegment?.revealAt ?? 0}
            framing={framing}
          />
        </div>
        {/* Scrim that keeps the header text readable when a province or a leader
            line runs underneath. It follows the safe-area top margin, so it
            covers exactly the band the platform status bar occupies. The bottom
            band has no scrim: the footer carries no text and the map runs to the
            canvas edge. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: design.topMargin + 180,
            background: HEADER_SCRIM,
            opacity: titleOpacity,
            pointerEvents: "none",
          }}
        />
        {/* Every headline is anchored to the safe rectangle: below the status
            bar, left of the right-hand action rail and above the caption. */}
        <header
          style={{
            position: "absolute",
            top: design.core.y0 + 24,
            left: 48,
            right: 48,
            textAlign: "center",
            opacity: intro * titleOpacity,
            transform: `translateY(${(1 - intro) * 18 - (1 - titleOpacity) * 16}px)`,
          }}
        >
          {/* <div style={{ fontSize: 22, letterSpacing: 7, color: theme.accent }}>
            DATA / THAILAND
          </div> */}
          <h1
            style={{
              fontSize: titleFontSize,
              lineHeight: 1.15,
              margin: "18px 0 8px",
              letterSpacing: 1,
              overflowWrap: "anywhere",
              textAlign: "center",

              // 最多显示两行
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              overflow: "hidden",
            }}
          >
            {project.title}
          </h1>
          <div style={{ fontSize: 28, color: theme.mutedText }}>
            {project.subtitle}
          </div>
        </header>
        <footer
          style={{
            position: "absolute",
            bottom: design.bottomMargin + 24,
            left: design.core.x0,
            right: design.rightMargin,
            display: "flex",
            justifyContent: "space-between",
            fontSize: 18,
            letterSpacing: 3,
            color: theme.mutedText,
          }}
        >
          {/* <span>PROVINCE DATA VISUALIZATION</span> */}
          {/* <span>
            {String(project.rankings.length).padStart(2, "0")} PROVINCES
          </span> */}
        </footer>
        {/* Development-only overlay: rendered only when the props explicitly ask
            for it, and the production render props never do. */}
        {isDebugOverlayEnabled(project) ? (
          <SafeAreaOverlay resolution={safeArea} />
        ) : null}
      </div>
      {project.audioSrc ? <Audio src={staticFile(project.audioSrc)} /> : null}
    </AbsoluteFill>
  );
};
