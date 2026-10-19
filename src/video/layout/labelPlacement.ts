/**
 * 浮动排名标签的落位算法。
 *
 * 这段逻辑原来内联在 `ThailandMap.tsx` 里，现在抽成独立模块（**同一套**算法，
 * 不是第二份实现），目的有三个：
 *
 * 1. 可以在 Node 里直接单测（`scripts/safearea/safe-area.test.mjs`）——
 *    标签落位是安全区适配里最容易出问题的一环。
 * 2. 地图组件、生成日志与安全区审计共用同一份计算，预览和成片不会算出
 *    两个不同的标签位置。
 * 3. 在这里扩展平台 UI 避让：标签不仅不能越出安全区，也不能压到右侧互动栏
 *    的禁入区（头像 / 点赞 / 评论 / 收藏 / 分享）。
 *
 * 模块零 import，保持可被 Node 类型擦除后直接执行。
 */

export type LabelRect = {x0: number; y0: number; x1: number; y1: number};

/** 标签面板尺寸（设计画布像素）。 */
export const LABEL_BOX = {width: 285, height: 105};
/** 面板相对锚点的默认偏移。 */
export const LABEL_OFFSET_X = 75;
export const LABEL_OFFSET_Y = 112;
/** 锚点与面板距安全区边缘的最小距离。 */
export const EDGE_MARGIN = 10;

export type LabelConflict = {
  code: "KEEP_OUT_OVERLAP" | "BOUNDS_OVERFLOW";
  detail: string;
  /** 冲突程度：与禁入区重叠的像素面积 + 越出安全区的像素面积（取整）。 */
  penaltyPx: number;
};

export type LabelPlacement = {
  anchor: [number, number];
  panel: [number, number];
  /** 引线 `x1, y1, x2, y2`。 */
  line: [number, number, number, number];
  /** 面板矩形，方便交给安全区审计。 */
  panelRect: LabelRect;
  flipped: boolean;
  /** 无法完全避开禁入区时给出可定位的问题；避开时为 null。 */
  conflict: LabelConflict | null;
};

export type PlaceLabelInput = {
  /** 目标区域在地图上的投影中心。 */
  cx: number;
  cy: number;
  /** 锚点允许区域（地图可用区）。 */
  rect: LabelRect;
  /** 面板允许区域（安全区里的标签安全矩形）。 */
  panelBounds: LabelRect;
  /** 右侧互动栏禁入区（已含额外间距）。null / 省略表示没有禁入区。 */
  keepOut?: LabelRect | null;
  box?: {width: number; height: number};
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const rectWidth = (rect: LabelRect): number => rect.x1 - rect.x0;
const rectHeight = (rect: LabelRect): number => rect.y1 - rect.y0;

const overlapArea = (a: LabelRect, b: LabelRect): number => {
  const width = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const height = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return width > 0 && height > 0 ? width * height : 0;
};

/**
 * 候选位置的代价：先保证不越出安全区（越界 1px 的代价远大于压住禁入区
 * 1px²），其次尽量不压住右侧互动栏。0 表示完全合格。
 */
const evaluate = (
  panel: LabelRect,
  bounds: LabelRect,
  keepOut: LabelRect | null,
): {keepOutArea: number; overflowPx: number; penalty: number} => {
  const keepOutArea = keepOut ? overlapArea(panel, keepOut) : 0;
  const overflowPx = Math.max(
    bounds.x0 - panel.x0,
    panel.x1 - bounds.x1,
    bounds.y0 - panel.y0,
    panel.y1 - bounds.y1,
    0,
  );
  return {keepOutArea, overflowPx, penalty: overflowPx * 1e6 + keepOutArea};
};

/**
 * 计算标签面板与引线位置。
 *
 * 优先沿用原来的"贴着锚点、放不下就翻到左侧"策略；只有当这个首选位置会压到
 * 右侧互动栏禁入区时才尝试其它候选（左移、上移、下移、翻到锚点左侧），并在
 * 候选里挑冲突最小的一个。**不会**为了避开禁入区去缩小字号或移动地图。
 */
export const placeLabel = ({
  cx,
  cy,
  rect,
  panelBounds,
  keepOut = null,
  box = LABEL_BOX,
}: PlaceLabelInput): LabelPlacement => {
  const width = box.width;
  const height = box.height;

  const anchorX = clamp(cx, rect.x0 + EDGE_MARGIN, Math.max(rect.x0 + EDGE_MARGIN, rect.x1 - EDGE_MARGIN));
  const anchorY = clamp(cy, rect.y0 + EDGE_MARGIN, Math.max(rect.y0 + EDGE_MARGIN, rect.y1 - EDGE_MARGIN));

  const panelMinX = panelBounds.x0 + EDGE_MARGIN;
  const panelMaxX = Math.max(panelMinX, panelBounds.x1 - width - EDGE_MARGIN);
  const panelMinY = panelBounds.y0;
  const panelMaxY = Math.max(panelMinY, panelBounds.y1 - height);

  const clampX = (value: number): number => clamp(value, panelMinX, panelMaxX);
  const clampY = (value: number): number => clamp(value, panelMinY, panelMaxY);

  // 首选：原来的行为。锚点右侧放不下就翻到左侧。
  const flip = anchorX + LABEL_OFFSET_X + width > panelMaxX;
  const preferredX = clampX(
    flip ? anchorX - LABEL_OFFSET_X - width : anchorX + LABEL_OFFSET_X,
  );
  const preferredY = clampY(anchorY - LABEL_OFFSET_Y);

  const candidates: Array<{x: number; y: number; flipped: boolean; kind: string}> = [
    {x: preferredX, y: preferredY, flipped: flip, kind: "preferred"},
  ];

  if (keepOut && overlapArea({x0: preferredX, y0: preferredY, x1: preferredX + width, y1: preferredY + height}, keepOut) > 0) {
    // 1) 整体左移到禁入区左侧。
    candidates.push({
      x: clampX(Math.min(preferredX, keepOut.x0 - width - EDGE_MARGIN)),
      y: preferredY,
      flipped: true,
      kind: "push-left",
    });
    // 2) 抬到禁入区上方。
    candidates.push({
      x: preferredX,
      y: clampY(keepOut.y0 - height - EDGE_MARGIN),
      flipped: flip,
      kind: "push-up",
    });
    // 3) 压到禁入区下方（底部安全区通常不允许，clamp 会把候选拉回安全区内，
    //    所以这一步更多是给"禁入区贴在顶部"的平台用）。
    candidates.push({
      x: preferredX,
      y: clampY(keepOut.y1 + EDGE_MARGIN),
      flipped: flip,
      kind: "push-down",
    });
    // 4) 翻到锚点左侧，同时避开禁入区。
    candidates.push({
      x: clampX(anchorX - LABEL_OFFSET_X - width),
      y: preferredY,
      flipped: true,
      kind: "flip-left",
    });
  }

  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  let bestDetail = {keepOutArea: 0, overflowPx: 0};
  for (const candidate of candidates) {
    const panelRect: LabelRect = {
      x0: candidate.x,
      y0: candidate.y,
      x1: candidate.x + width,
      y1: candidate.y + height,
    };
    const score = evaluate(panelRect, panelBounds, keepOut);
    // 严格小于：候选顺序即优先级，平局时保留更靠前的策略。
    if (score.penalty + 1e-6 < bestScore) {
      bestScore = score.penalty;
      best = candidate;
      bestDetail = score;
    }
  }

  const panelX = best.x;
  const panelY = best.y;
  const panelRect: LabelRect = {
    x0: panelX,
    y0: panelY,
    x1: panelX + width,
    y1: panelY + height,
  };
  const towardsRight = panelX >= anchorX;
  const lineY = clamp(anchorY - 55, panelY, panelY + height);

  let conflict: LabelConflict | null = null;
  if (bestDetail.keepOutArea > 0) {
    const keepOutRect = keepOut as LabelRect;
    const overlapWidth = Math.round(
      Math.min(panelRect.x1, keepOutRect.x1) - Math.max(panelRect.x0, keepOutRect.x0),
    );
    const overlapHeight = Math.round(
      Math.min(panelRect.y1, keepOutRect.y1) - Math.max(panelRect.y0, keepOutRect.y0),
    );
    conflict = {
      code: "KEEP_OUT_OVERLAP",
      penaltyPx: Math.round(bestDetail.keepOutArea),
      detail:
        `标签面板仍与右侧互动栏禁入区重叠 ${Math.max(0, overlapWidth)}x${Math.max(
          0,
          overlapHeight,
        )}px（面板 x ${Math.round(panelRect.x0)}~${Math.round(panelRect.x1)}, ` +
        `y ${Math.round(panelRect.y0)}~${Math.round(panelRect.y1)}；` +
        `禁入区 x ${Math.round(keepOutRect.x0)}~${Math.round(keepOutRect.x1)}, ` +
        `y ${Math.round(keepOutRect.y0)}~${Math.round(keepOutRect.y1)}），` +
        `安全区已用尽（安全区宽 ${Math.round(rectWidth(panelBounds))}px，标签宽 ${width}px）`,
    };
  } else if (bestDetail.overflowPx > 0) {
    conflict = {
      code: "BOUNDS_OVERFLOW",
      penaltyPx: Math.round(bestDetail.overflowPx),
      detail:
        `标签面板越出标签安全区（面板 x ${Math.round(panelRect.x0)}~${Math.round(
          panelRect.x1,
        )}, y ${Math.round(panelRect.y0)}~${Math.round(panelRect.y1)}；` +
        `安全区 x ${Math.round(panelBounds.x0)}~${Math.round(panelBounds.x1)}, ` +
        `y ${Math.round(panelBounds.y0)}~${Math.round(panelBounds.y1)}）`,
    };
  }

  return {
    anchor: [anchorX, anchorY],
    panel: [panelX, panelY],
    line: [
      anchorX + 10 * (towardsRight ? 1 : -1),
      anchorY - 5,
      towardsRight ? panelX : panelX + width,
      lineY,
    ],
    panelRect,
    flipped: best.flipped,
    conflict,
  };
};

/** 安全区审计用：面板是否完整落在标签安全区内。 */
export const labelFitsBounds = (
  placement: LabelPlacement,
  bounds: LabelRect,
): boolean =>
  placement.panelRect.x0 >= bounds.x0 &&
  placement.panelRect.y0 >= bounds.y0 &&
  placement.panelRect.x1 <= bounds.x1 &&
  placement.panelRect.y1 <= bounds.y1;

/** 面板宽度 / 高度，供调用方做布局判断。 */
export const labelBoxSize = (box = LABEL_BOX): {width: number; height: number} => ({
  width: box.width,
  height: box.height,
});

/** 标签矩形面积（诊断用）。 */
export const labelRectArea = (rect: LabelRect): number =>
  Math.max(0, rectWidth(rect)) * Math.max(0, rectHeight(rect));
