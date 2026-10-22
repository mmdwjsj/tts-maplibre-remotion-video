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
  /** 面板落在锚点的哪个方向（hx/vy 各取 -1/0/1），供调试与测试用。 */
  side: {hx: number; vy: number};
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
  /**
   * 画面中心（画布或安全区中心）。面板默认放在它的**反方向**：府在左下角就
   * 把标签放到右上，府在右上角就放到左下——这正是行业里 callout 标注的常见
   * 做法，标签永远落在偏空的那一侧，而不是压在府上。
   */
  focus?: {x: number; y: number} | null;
  /**
   * 必须让开的矩形：当前府的投影包围盒。面板压到它上面就等于盖住了主角，
   * 代价低于越界、高于其它一切。
   */
  avoid?: LabelRect[] | null;
  /** 尽量让开的矩形：其它府（尤其已点亮府）的包围盒。 */
  obstacles?: LabelRect[] | null;
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
 * 候选位置的代价，按**优先级**逐级比较，而不是加权求和。
 *
 * 顺序就是产品优先级：先把面板完整塞进安全区，再保证不盖住当前府（主角），
 * 其次不压右侧互动栏，最后尽量少压其它府。分级的理由是「越界 1px」和「压住
 * 府 1000px²」不该互相抵消——加权总分会让一个越界的候选因为多躲开一点陆地
 * 反而胜出。
 */
type CandidateScore = {
  overflowPx: number;
  avoidArea: number;
  keepOutArea: number;
  otherArea: number;
};

const better = (a: CandidateScore, b: CandidateScore): boolean => {
  if (Math.abs(a.overflowPx - b.overflowPx) > 1e-6) return a.overflowPx < b.overflowPx;
  if (Math.abs(a.avoidArea - b.avoidArea) > 1e-6) return a.avoidArea < b.avoidArea;
  if (Math.abs(a.keepOutArea - b.keepOutArea) > 1e-6) return a.keepOutArea < b.keepOutArea;
  return a.otherArea < b.otherArea;
};

const totalOverlap = (panel: LabelRect, rects: LabelRect[]): number =>
  rects.reduce((sum, rect) => sum + overlapArea(panel, rect), 0);

/**
 * 计算标签面板与引线位置。
 *
 * 落位规则（callout 的通用做法）：
 *
 * 1. **反方向**：锚点在画面左下 → 面板去右上；锚点在右上 → 面板去左下。
 *    面板总是走向更空的那一侧，而不是压在府上。
 * 2. **先躲主角**：面板与当前府包围盒重叠的代价仅次于越界，所以哪怕反方向
 *    也放不下（贴边），也会先退而求其次换到上下/左右，而不是盖住府。
 * 3. **再躲 UI**：右侧互动栏禁入区、安全区边界照旧。
 * 4. **引线**：从锚点连到面板**边缘最近点**，长度只有几十像素，明确指向哪个府。
 *
 * 面板尺寸不变，也不会为了避让去缩小字号或移动地图。
 */
export const placeLabel = ({
  cx,
  cy,
  rect,
  panelBounds,
  keepOut = null,
  box = LABEL_BOX,
  focus = null,
  avoid = null,
  obstacles = null,
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

  // 反方向：锚点在中心左侧 → 面板向右；锚点在中心上方 → 面板向下。
  const focusX = focus?.x ?? (panelBounds.x0 + panelBounds.x1) / 2;
  const focusY = focus?.y ?? (panelBounds.y0 + panelBounds.y1) / 2;
  const awayX = anchorX < focusX ? 1 : -1;
  const awayY = anchorY < focusY ? 1 : -1;

  /**
   * 面板与"主角"之间的空隙。
   *
   * 位置以府的真实包围盒为基准而不是锚点中心：贴着府的外沿让开 14px，面板就
   * 不会压住府，引线也就只有十几像素——这正是 callout 想要的效果。没有传入
   * 包围盒时退回"锚点 + 固定偏移"的老几何。
   */
  const own = avoid && avoid.length ? avoid[0] : null;
  const GAP_X = 58;
  const GAP_Y = 44;
  const CLEARANCE = 14;
  const positionFor = (hx: number, vy: number): {x: number; y: number} => ({
    x: clampX(
      hx > 0
        ? (own ? own.x1 + CLEARANCE : anchorX + GAP_X)
        : hx < 0
          ? (own ? own.x0 - CLEARANCE - width : anchorX - GAP_X - width)
          : anchorX - width / 2,
    ),
    y: clampY(
      vy > 0
        ? (own ? own.y1 + CLEARANCE : anchorY + GAP_Y)
        : vy < 0
          ? (own ? own.y0 - CLEARANCE - height : anchorY - GAP_Y - height)
          : anchorY - height / 2,
    ),
  });

  // 对角优先，其次是只在一根轴上让开；最后才是"靠近侧"（几乎肯定压住府，
  // 只在周围全是陆地/UI 时兜底）。
  const sides = [
    {hx: awayX, vy: awayY, kind: "diagonal-away"},
    {hx: awayX, vy: 0, kind: "side-away"},
    {hx: 0, vy: awayY, kind: "stack-away"},
    {hx: -awayX, vy: -awayY, kind: "diagonal-near"},
    {hx: -awayX, vy: 0, kind: "side-near"},
    {hx: 0, vy: -awayY, kind: "stack-near"},
  ];

  const candidates: Array<{x: number; y: number; hx: number; vy: number; kind: string}> = [];
  for (const side of sides) {
    const {x, y} = positionFor(side.hx, side.vy);
    candidates.push({x, y, ...side});
    if (!keepOut) continue;
    const panel: LabelRect = {x0: x, y0: y, x1: x + width, y1: y + height};
    if (overlapArea(panel, keepOut) <= 0) continue;
    // 压到互动栏时，同方向再试三个"贴着禁入区边"的位置。
    candidates.push({
      x: clampX(Math.min(x, keepOut.x0 - width - EDGE_MARGIN)),
      y,
      hx: side.hx,
      vy: side.vy,
      kind: `${side.kind}-push-left`,
    });
    candidates.push({
      x,
      y: clampY(keepOut.y0 - height - EDGE_MARGIN),
      hx: side.hx,
      vy: side.vy,
      kind: `${side.kind}-push-up`,
    });
    candidates.push({
      x,
      y: clampY(keepOut.y1 + EDGE_MARGIN),
      hx: side.hx,
      vy: side.vy,
      kind: `${side.kind}-push-down`,
    });
  }

  const avoidRects = avoid ?? [];
  const obstacleRects = obstacles ?? [];

  const scoreOf = (panel: LabelRect): CandidateScore => ({
    overflowPx: Math.max(
      panelBounds.x0 - panel.x0,
      panel.x1 - panelBounds.x1,
      panelBounds.y0 - panel.y0,
      panel.y1 - panelBounds.y1,
      0,
    ),
    avoidArea: totalOverlap(panel, avoidRects),
    keepOutArea: keepOut ? overlapArea(panel, keepOut) : 0,
    otherArea: totalOverlap(panel, obstacleRects),
  });

  let best = candidates[0];
  let bestScore = scoreOf({
    x0: best.x,
    y0: best.y,
    x1: best.x + width,
    y1: best.y + height,
  });
  for (const candidate of candidates.slice(1)) {
    const score = scoreOf({
      x0: candidate.x,
      y0: candidate.y,
      x1: candidate.x + width,
      y1: candidate.y + height,
    });
    if (better(score, bestScore)) {
      bestScore = score;
      best = candidate;
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

  // 引线连到面板边缘的最近点：横向在外侧就连竖边，纵向在外侧就连横边。
  let lineX2: number;
  let lineY2: number;
  if (anchorX < panelRect.x0) {
    lineX2 = panelRect.x0;
    lineY2 = clamp(anchorY, panelY + 16, panelY + height - 16);
  } else if (anchorX > panelRect.x1) {
    lineX2 = panelRect.x1;
    lineY2 = clamp(anchorY, panelY + 16, panelY + height - 16);
  } else if (anchorY < panelY) {
    lineX2 = clamp(anchorX, panelX + 16, panelX + width - 16);
    lineY2 = panelY;
  } else {
    lineX2 = clamp(anchorX, panelX + 16, panelX + width - 16);
    lineY2 = panelRect.y1;
  }
  // 起点从锚点往外让 6px，避免和锚点圆点糊在一起。
  const dx = lineX2 - anchorX;
  const dy = lineY2 - anchorY;
  const length = Math.hypot(dx, dy) || 1;
  const lineX1 = anchorX + (dx / length) * 6;
  const lineY1 = anchorY + (dy / length) * 6;

  let conflict: LabelConflict | null = null;
  if (bestScore.keepOutArea > 0) {
    const keepOutRect = keepOut as LabelRect;
    const overlapWidth = Math.round(
      Math.min(panelRect.x1, keepOutRect.x1) - Math.max(panelRect.x0, keepOutRect.x0),
    );
    const overlapHeight = Math.round(
      Math.min(panelRect.y1, keepOutRect.y1) - Math.max(panelRect.y0, keepOutRect.y0),
    );
    conflict = {
      code: "KEEP_OUT_OVERLAP",
      penaltyPx: Math.round(bestScore.keepOutArea),
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
  } else if (bestScore.overflowPx > 0) {
    conflict = {
      code: "BOUNDS_OVERFLOW",
      penaltyPx: Math.round(bestScore.overflowPx),
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
    line: [lineX1, lineY1, lineX2, lineY2],
    panelRect,
    flipped: !towardsRight,
    side: {hx: best.hx, vy: best.vy},
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
