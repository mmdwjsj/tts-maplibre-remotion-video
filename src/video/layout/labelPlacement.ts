/**
 * 排名标签的落位算法。
 *
 * 2026-11-08：标签是不带卡片的**三行纯文字**（RANK / 府名 / 数值），压在排名府
 * **自身的上半部分**——不是浮在府外面的空白或海面上，而是直接盖在府这个形状
 * 里面。水平方向以府的包围盒中心为基准整体居中（三行都用 `text-anchor:
 * middle`），所以第二行府名的中心与府的中心对齐；垂直方向让文字块的底边落在
 * 府的中心线上，整块占住府的上半部——这就是「数据在排名府的上面」的字面含义。
 *
 * 府太矮、装不下三行时不再跑到府外，而是保持从府内上沿起排、向下略微越过
 * 中心线（仍然压在府身上）；小府本来就会被文字盖住大半，这比把读数甩到
 * 海面上要容易对应。
 *
 * 所有读数**常驻**（解说往后走、前面的数字不撤），相邻小府的默认位会撞车：
 * 通过 `occupied` 传入先落位的标签矩形，撞车时先退到府的下半部（仍然压着
 * 府），再逐级向下平移让出空位 —— 宁可离府稍远一点，也不让两团数字糊在一起。
 *
 * 只保留两条必要的健壮性规则，它们不是第二套布局：
 *
 * 1. **水平 clamp**：府贴着核心区左右边时，文字块整体收进核心区，否则会
 *    被裁掉半个府名；
 * 2. **不要越出核心区**：府贴着核心区上/下沿时，文字块被推回核心区内。
 *
 * 另外右侧互动栏（头像 / 点赞 / 评论 / 收藏 / 分享）会挡住标签，所以与禁入区
 * 重叠时做**最小的水平左移**，仍然压在府上并尽量保持中心对齐；确实让不开
 * 时如实报 `KEEP_OUT_OVERLAP`，不静默隐藏。
 *
 * 模块零 import，保持可被 Node 类型擦除后直接执行。
 */

export type LabelRect = {x0: number; y0: number; x1: number; y1: number};

/** 标签文字块的包围尺寸（设计画布像素）：三行文字的估算外框，用于边界判断。 */
export const LABEL_BOX = {width: 280, height: 102};
/** 文字块上沿距府上沿的内边距：文字压进府内，而不是贴着府的外轮廓。 */
export const LABEL_INSET_PX = 8;
/** 文字块距核心区边缘的最小距离。 */
export const EDGE_MARGIN = 10;

export type LabelConflict = {
  code: "KEEP_OUT_OVERLAP" | "BOUNDS_OVERFLOW";
  detail: string;
  /** 冲突程度：与禁入区重叠的像素面积 + 越出核心区的像素面积（取整）。 */
  penaltyPx: number;
};

export type LabelPlacement = {
  /** 府的投影中心（文字块的水平基准），供调试与测试用。 */
  anchor: [number, number];
  /** 文字块左上角。 */
  panel: [number, number];
  /** 文字块矩形，方便交给安全区审计。 */
  panelRect: LabelRect;
  /** 为了让开右侧互动栏而左移的像素（0 表示严格中心对齐）。 */
  keepOutShiftPx: number;
  /** 无法完全避开禁入区或越出核心区时给出可定位的问题；正常时为 null。 */
  conflict: LabelConflict | null;
};

export type PlaceLabelInput = {
  /** 府的投影包围盒：决定水平中心，以及文字块的上下基准。 */
  bounds: LabelRect;
  /** 文字允许区域（中间核心区）。 */
  panelBounds: LabelRect;
  box?: {width: number; height: number};
  /** 文字块上沿距府上沿的内边距，默认 {@link LABEL_INSET_PX}。 */
  insetPx?: number;
  /** 右侧互动栏禁入区（已含额外间距）。null / 省略表示没有禁入区。 */
  keepOut?: LabelRect | null;
  /**
   * 已被前面标签占用的矩形（同一画面里先落位的那些）。所有读数常驻后，
   * 相邻小府的默认位会撞车：本标签先按上半部落位，与占用矩形重叠时退到
   * 府的下半部（仍然压着府），再不行就逐级向下平移让出空位。调用方按
   * 揭示顺序传入，结果因此逐帧稳定、不会抖动。
   */
  occupied?: LabelRect[];
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const overlapArea = (a: LabelRect, b: LabelRect): number => {
  const width = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const height = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return width > 0 && height > 0 ? width * height : 0;
};

const rectOf = (x: number, y: number, width: number, height: number): LabelRect => ({
  x0: x,
  y0: y,
  x1: x + width,
  y1: y + height,
});

/**
 * 计算文字块位置。
 *
 * 横向：府中心 = 文字块中心；靠边收进核心区；压到右侧互动栏时只做最小左移。
 * 纵向：文字块压在府内上半部，底边贴府的中心线；府太矮时从府内上沿起排。
 */
export const placeLabel = ({
  bounds,
  panelBounds,
  box = LABEL_BOX,
  insetPx = LABEL_INSET_PX,
  keepOut = null,
  occupied = [],
}: PlaceLabelInput): LabelPlacement => {
  const width = box.width;
  const height = box.height;

  const cx = (bounds.x0 + bounds.x1) / 2;
  const cy = (bounds.y0 + bounds.y1) / 2;

  const minX = panelBounds.x0 + EDGE_MARGIN;
  const maxX = Math.max(minX, panelBounds.x1 - width - EDGE_MARGIN);
  const centredX = cx - width / 2;
  let x0 = clamp(centredX, minX, maxX);

  // 纵向：整块压在府的上半部。
  //  - 府够高：底边贴府的中心线（`cy - height`），文字块完全占住府的上半部；
  //  - 府太矮：从府内上沿（`bounds.y0 + inset`）起排，向下略微越过中心线，
  //    但仍然压在府身上 —— 绝不跑到府外面去。
  const insideTop = bounds.y0 + insetPx;
  const aboveCentre = cy - height;
  const minY = panelBounds.y0;
  const maxY = Math.max(panelBounds.y0, panelBounds.y1 - height);
  let y0 = clamp(Math.max(insideTop, aboveCentre), minY, maxY);

  // 已有读数常驻后，相邻小府的默认位会撞车：先退到府的下半部（仍压着府，
  // 又与上半部的标签天然错开），还不行就逐级向下平移让出空位。
  const hitsOccupied = (y: number): boolean => {
    const panel = rectOf(x0, y, width, height);
    return occupied.some((rect) => overlapArea(panel, rect) > 0);
  };
  if (occupied.length > 0 && hitsOccupied(y0)) {
    let candidate = clamp(cy, minY, maxY);
    while (hitsOccupied(candidate) && candidate < maxY) {
      candidate = Math.min(candidate + height / 2, maxY);
    }
    y0 = candidate;
  }

  // 右侧互动栏：保留「压在府上」这条规则，只把文字块水平挪开最小的距离。
  let keepOutShiftPx = 0;
  if (keepOut) {
    const panel = rectOf(x0, y0, width, height);
    if (overlapArea(panel, keepOut) > 0) {
      const shifted = keepOut.x0 - width - EDGE_MARGIN;
      if (shifted >= minX) {
        keepOutShiftPx = Math.round(x0 - shifted);
        x0 = shifted;
      } else if (keepOut.x1 + EDGE_MARGIN + width <= panelBounds.x1) {
        keepOutShiftPx = Math.round(x0 - (keepOut.x1 + EDGE_MARGIN));
        x0 = keepOut.x1 + EDGE_MARGIN;
      }
      // 左右都让不开时保持中心对齐，交给下面的 conflict 如实报告。
    }
  }

  const panelRect = rectOf(x0, y0, width, height);

  const overflowPx = Math.max(
    panelBounds.x0 - panelRect.x0,
    panelRect.x1 - panelBounds.x1,
    panelBounds.y0 - panelRect.y0,
    panelRect.y1 - panelBounds.y1,
    0,
  );
  const keepOutArea = keepOut ? overlapArea(panelRect, keepOut) : 0;

  let conflict: LabelConflict | null = null;
  if (keepOutArea > 0 && keepOut) {
    const overlapWidth = Math.round(
      Math.min(panelRect.x1, keepOut.x1) - Math.max(panelRect.x0, keepOut.x0),
    );
    const overlapHeight = Math.round(
      Math.min(panelRect.y1, keepOut.y1) - Math.max(panelRect.y0, keepOut.y0),
    );
    conflict = {
      code: "KEEP_OUT_OVERLAP",
      penaltyPx: Math.round(keepOutArea),
      detail:
        `排名文字仍与右侧互动栏禁入区重叠 ${Math.max(0, overlapWidth)}x${Math.max(
          0,
          overlapHeight,
        )}px（文字 x ${Math.round(panelRect.x0)}~${Math.round(panelRect.x1)}, ` +
        `y ${Math.round(panelRect.y0)}~${Math.round(panelRect.y1)}；` +
        `禁入区 x ${Math.round(keepOut.x0)}~${Math.round(keepOut.x1)}, ` +
        `y ${Math.round(keepOut.y0)}~${Math.round(keepOut.y1)}），` +
        `核心区宽 ${Math.round(panelBounds.x1 - panelBounds.x0)}px、文字宽 ${width}px，左右都已让不开`,
    };
  } else if (overflowPx > 0) {
    conflict = {
      code: "BOUNDS_OVERFLOW",
      penaltyPx: Math.round(overflowPx),
      detail:
        `排名文字越出中间核心内容区（文字 x ${Math.round(panelRect.x0)}~${Math.round(
          panelRect.x1,
        )}, y ${Math.round(panelRect.y0)}~${Math.round(panelRect.y1)}；` +
        `核心区 x ${Math.round(panelBounds.x0)}~${Math.round(panelBounds.x1)}, ` +
        `y ${Math.round(panelBounds.y0)}~${Math.round(panelBounds.y1)}）`,
    };
  }

  const insideProvince =
    panelRect.y0 >= bounds.y0 &&
    panelRect.y1 <= bounds.y1 &&
    panelRect.x0 >= bounds.x0 &&
    panelRect.x1 <= bounds.x1;

  return {
    anchor: [cx, cy],
    panel: [x0, y0],
    panelRect,
    keepOutShiftPx,
    conflict,
  };
};

/** 安全区审计用：文字块是否完整落在中间核心内容区内。 */
export const labelFitsBounds = (
  placement: LabelPlacement,
  bounds: LabelRect,
): boolean =>
  placement.panelRect.x0 >= bounds.x0 &&
  placement.panelRect.y0 >= bounds.y0 &&
  placement.panelRect.x1 <= bounds.x1 &&
  placement.panelRect.y1 <= bounds.y1;

/** 文字块宽度 / 高度，供调用方做布局判断。 */
export const labelBoxSize = (box = LABEL_BOX): {width: number; height: number} => ({
  width: box.width,
  height: box.height,
});

/** 标签矩形面积（诊断用）。 */
export const labelRectArea = (rect: LabelRect): number =>
  Math.max(0, rect.x1 - rect.x0) * Math.max(0, rect.y1 - rect.y0);
