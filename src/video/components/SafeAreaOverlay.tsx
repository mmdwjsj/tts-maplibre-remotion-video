import React from "react";
import type {SafeAreaResolution, SafeRect} from "../../safearea/safeArea";

/**
 * 安全区可视化遮罩（**仅开发预览用**）。
 *
 * 只在 `project.debugSafeArea === true` 时渲染。正式导出的 render props 里不
 * 写这个字段（见 `scripts/web-server.mjs` 里构造 renderProps 的地方），所以
 * MP4 永远不会带上遮罩、边框或安全区文字。
 *
 * 画的东西：
 * - 安全区外部 → 半透明遮罩
 * - 核心内容安全区 → 清晰实线边框
 * - 右侧互动栏禁入区 → 另一种颜色（橙红）
 * - 每个区域的名称与边界坐标
 */

type Props = {
  resolution: SafeAreaResolution;
};

const MASK = "rgba(4, 10, 14, 0.55)";
const CORE_STROKE = "#29e5d2";
const KEEP_OUT_STROKE = "#ff8a5c";
const LABEL_COLOR = "#d8f7f2";
const MONO = "Consolas, Menlo, monospace";

const rectBox = (rect: SafeRect) => ({
  x: rect.x0,
  y: rect.y0,
  width: Math.max(0, rect.x1 - rect.x0),
  height: Math.max(0, rect.y1 - rect.y0),
});

/** 顶部 / 底部 / 左 / 右四条预留带，用半透明遮罩压暗。 */
const MaskBands: React.FC<{resolution: SafeAreaResolution}> = ({resolution}) => {
  const bands = [
    {key: "top", rect: resolution.topBandRect},
    {key: "bottom", rect: resolution.bottomBandRect},
    {key: "left", rect: resolution.leftBandRect},
    {key: "right", rect: resolution.rightBandRect},
  ];
  return (
    <g>
      {bands.map(({key, rect}) => (
        <rect key={key} {...rectBox(rect)} fill={MASK} />
      ))}
    </g>
  );
};

export const SafeAreaOverlay: React.FC<Props> = ({resolution}) => {
  const {coreRect, labelRect, interactiveRect, interactiveGapRect, mapRect, canvas} =
    resolution;
  const captions: Array<{x: number; y: number; text: string}> = [
    {
      x: coreRect.x0 + 6,
      y: coreRect.y0 - 10,
      text: `核心安全区 ${Math.round(coreRect.x0)}~${Math.round(coreRect.x1)} × ${Math.round(
        coreRect.y0,
      )}~${Math.round(coreRect.y1)}`,
    },
    {
      x: labelRect.x0 + 6,
      y: labelRect.y0 - 8,
      text: `标签安全区 ${Math.round(labelRect.x0)}~${Math.round(labelRect.x1)} × ${Math.round(
        labelRect.y0,
      )}~${Math.round(labelRect.y1)}`,
    },
    {
      // 顶部预留写在遮罩带自己的顶部，避免和「核心安全区」标注撞在同一行。
      x: 24,
      y: resolution.topBandRect.y0 + 26,
      text: `顶部预留 ${resolution.margins.top}px`,
    },
    {
      x: 24,
      // 底部预留带内自上往下排，避开视频自己的 footer 文字（约在 y 1416）。
      y: resolution.bottomBandRect.y0 + 54,
      text: `底部预留 ${resolution.margins.bottom}px（描述等级 ${resolution.descriptionTier} · ${resolution.descriptionChars} 字符）`,
    },
    {
      x: mapRect.x0 + 6,
      y: mapRect.y1 + 26,
      text: `地图底图可用区 y ${Math.round(mapRect.y0)}~${Math.round(mapRect.y1)}`,
    },
    {
      x: canvas.width - resolution.margins.right - 10,
      y: resolution.topBandRect.y1 + 18,
      text: `右侧预留 ${resolution.margins.right}px`,
    },
  ];

  return (
    <svg
      viewBox={`0 0 ${canvas.width} ${canvas.height}`}
      width={canvas.width}
      height={canvas.height}
      style={{position: "absolute", top: 0, left: 0, pointerEvents: "none"}}
    >
      <MaskBands resolution={resolution} />

      {/* 地图底图可用区：底图允许延伸到画布边缘，只提示纵向范围 */}
      <rect
        {...rectBox(mapRect)}
        fill="none"
        stroke="rgba(41,229,210,0.35)"
        strokeWidth={2}
        strokeDasharray="10 8"
      />

      {/* 核心内容安全区 */}
      <rect {...rectBox(coreRect)} fill="none" stroke={CORE_STROKE} strokeWidth={3} />

      {/* 浮动标签安全区 */}
      <rect
        {...rectBox(labelRect)}
        fill="none"
        stroke={CORE_STROKE}
        strokeWidth={1.5}
        strokeDasharray="6 6"
      />

      {/* 右侧互动栏禁入区（另一种颜色，便于一眼区分） */}
      {interactiveRect ? (
        <rect
          {...rectBox(interactiveRect)}
          fill="rgba(255,138,92,0.18)"
          stroke={KEEP_OUT_STROKE}
          strokeWidth={3}
        />
      ) : null}
      {interactiveGapRect ? (
        <rect
          {...rectBox(interactiveGapRect)}
          fill="none"
          stroke={KEEP_OUT_STROKE}
          strokeWidth={1.5}
          strokeDasharray="4 6"
        />
      ) : null}
      {interactiveRect ? (
        <text
          // 禁入区只有 180px 宽，横排文字放不下：右对齐贴画布右缘，避免被裁掉。
          x={canvas.width - 12}
          y={interactiveRect.y0 + 24}
          fill={KEEP_OUT_STROKE}
          fontSize="17"
          fontWeight="700"
          fontFamily={MONO}
          textAnchor="end"
        >
          {`互动栏禁入区 ${Math.round(interactiveRect.x0)},${Math.round(
            interactiveRect.y0,
          )} ${Math.round(interactiveRect.x1 - interactiveRect.x0)}×${Math.round(
            interactiveRect.y1 - interactiveRect.y0,
          )}`}
        </text>
      ) : null}

      {captions.map((caption) => (
        <text
          key={caption.text}
          x={caption.x}
          y={caption.y}
          fill={LABEL_COLOR}
          fontSize="17"
          fontFamily={MONO}
        >
          {caption.text}
        </text>
      ))}

      <text x={24} y={canvas.height - 16} fill={LABEL_COLOR} fontSize="17" fontFamily={MONO}>
        {`安全区预览（仅开发）· ${resolution.platformLabel} · 配置版本 ${resolution.version} · 参数为初始估值`}
      </text>
    </svg>
  );
};
