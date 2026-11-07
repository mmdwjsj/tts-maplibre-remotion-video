import React from "react";
import type {SafeAreaResolution, SafeRect} from "../../safearea/safeArea";

/**
 * 安全区可视化遮罩（**仅开发预览用**）。
 *
 * 只在 `project.debugSafeArea === true` 时渲染。正式导出的 render props 里不
 * 写这个字段（见 `scripts/web-server.mjs` 里构造 renderProps 的地方），所以
 * MP4 永远不会带上遮罩、边框或安全区文字。
 *
 * 2026-11-07 简化：只画四个分区，一眼能对上 TikTok 真实 UI ——
 * - 顶部导航 / 右侧互动栏 / 底部账号 ID 与描述 → 半透明压暗带
 * - 中间核心排名内容 → 唯一的一个实线框
 *
 * 不再画独立的橙红禁入区框、虚线内框、地图出血框，也不写任何边界坐标数字：
 * 那些都是同一套边界派生出来的几何量，不是分区，画出来只会让人以为还有别的区。
 */

type Props = {
  resolution: SafeAreaResolution;
};

const MASK = "rgba(4, 10, 14, 0.55)";
const CORE_STROKE = "#29e5d2";
const LABEL_COLOR = "#d8f7f2";
const CORE_LABEL_COLOR = "#12303f";
const MONO = "Consolas, Menlo, monospace";

const rectBox = (rect: SafeRect) => ({
  x: rect.x0,
  y: rect.y0,
  width: Math.max(0, rect.x1 - rect.x0),
  height: Math.max(0, rect.y1 - rect.y0),
});

/** 四个分区的外围留白，用半透明遮罩压暗。 */
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
  const {coreRect, canvas, margins} = resolution;
  const core = rectBox(coreRect);
  const captions: Array<{x: number; y: number; text: string; color: string}> = [
    {x: 24, y: 64, text: "顶部导航", color: LABEL_COLOR},
    {
      x: canvas.width - margins.right + 12,
      y: margins.top + 38,
      text: "右侧互动栏",
      color: LABEL_COLOR,
    },
    {
      x: 24,
      y: canvas.height - margins.bottom + 44,
      text: "账号 ID · 描述",
      color: LABEL_COLOR,
    },
    {
      x: core.x + 18,
      y: core.y + 44,
      text: "核心排名内容",
      color: CORE_LABEL_COLOR,
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

      {/* 整个画面只有这一个框：中间核心内容区 */}
      <rect {...core} fill="none" stroke={CORE_STROKE} strokeWidth={3} />

      {captions.map((caption) => (
        <text
          key={caption.text}
          x={caption.x}
          y={caption.y}
          fill={caption.color}
          fontSize="22"
          fontFamily={MONO}
        >
          {caption.text}
        </text>
      ))}

      <text x={24} y={canvas.height - 16} fill={LABEL_COLOR} fontSize="16" fontFamily={MONO}>
        {`四分区预览（仅开发）· ${resolution.platformLabel} · 配置 ${resolution.version} · 参数为初始估值`}
      </text>
    </svg>
  );
};
