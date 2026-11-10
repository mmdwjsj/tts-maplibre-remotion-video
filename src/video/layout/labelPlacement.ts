/**
 * 排名标签的落位算法。
 *
 * 2026-11-08：标签是不带卡片的**三行纯文字**（RANK / 府名 / 数值），压在排名府
 * 身上。唯一的定位铁律是：**第二行（泰文府名）的视觉中心 = 府的中心**。
 * 水平方向三行都用 `text-anchor: middle`，块的水平中点就是府包围盒中点；
 * 垂直方向把块顶放在 `府中心 − 名字中心在块内的偏移`，于是泰文名那一行的
 * 正中正好压住府中心，块自然上下对称地跨在府身上 —— 不论府高多少。
 *
 * 早期版本用的是「文字块底边贴府中心线」（整块占住府上半部），小府（曼谷
 * 83×56px）装不下 102px 高的三行时会退化成「从府内上沿起排」，整块被推到府
 * 中心以下、溢出到府外的水面，看起来就像数据掉到海里去了。现在没有这条
 * 退化规则：对齐优先，块该溢出就对称地溢出，读数始终以府为中心。
 *
 * 所有读数**常驻**（解说往后走、前面的数字不撤），相邻小府的默认位会撞车：
 * 通过 `occupied` 传入先落位的标签矩形，撞车时在**上下各一个文字块高度**以内
 * 找一个完全不重叠的位置（取位移最小的那个），让不开就保持严格对齐、把
 * 重叠如实交给安全区审计。绝不再无限往下平移 —— 那是读数飘到海面上的原因。
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

/* -------------------------------------------------------------------------- *
 * 三行读数的排版标尺（设计画布像素）
 *
 * 这是**唯一**一份字号/基线定义：渲染端 `ThailandMap`、安全区审计、以及网页
 * 预览图都从这里取值（预览通过 `/api/framing/preview` 的 `labelStyle` 拿到同一
 * 组数字），所以预览和成片不会出现「字号不一样」「行距不一样」。
 * -------------------------------------------------------------------------- */

/** 字号：NO. 行 / 府名行 / 数值行。 */
export const LABEL_FONT_SIZE = {rank: 18, name: 27, value: 20} as const;
/** 三行基线（相对文字块顶部）：行间距按**字形空隙**调，不是按基线等差。 */
export const LABEL_BASELINE = {rank: 26, name: 57, value: 84} as const;
/** 字形视觉中心相对基线的比例（约 0.35em，泰文与拉丁文都够用）。 */
export const LABEL_CENTRE_RATIO = 0.35;
/** 文字块底色描边（halo），压在府色或浅色地图上都可读。 */
export const LABEL_HALO = {color: "#FFFFFF", width: 6} as const;
/** 标签文字块的包围尺寸：三行文字的估算外框，用于边界判断与避让。 */
export const LABEL_BOX = {width: 230, height: 92};
/**
 * 第二行（府名）的视觉中心距文字块顶部的像素。
 *
 * 由基线反推，不是手填：`57 − 27 × 0.35 ≈ 47.55`。纵向落位就是
 * `块顶 = 府中心 − 这个值`，即「府名中心 = 府中心」。
 */
export const LABEL_NAME_CENTER_Y =
  LABEL_BASELINE.name - LABEL_FONT_SIZE.name * LABEL_CENTRE_RATIO;
/**
 * 撞车避让时允许的最大纵向位移：一个文字块高度。
 *
 * 有界是关键 —— 旧实现撞车时逐级往下平移直到不重叠，相邻小府叠加后可以把
 * 读数推到府下方两百多像素的空白/海面上。
 */
export const MAX_AVOID_SHIFT_PX = LABEL_BOX.height;
/**
 * 手动微调（预览图拖拽）允许的最大位移，单轴像素。
 *
 * 只用来兜住「拖飞了」：超过这个距离的输入被视为误操作，直接回落到自动落位
 * （`isLabelOffsetUsable` 返回 false），所以 MP4 里不会出现读数被拖到画面另一头
 * 的情况。渲染端与服务端用的是同一个上限。
 */
export const MAX_MANUAL_OFFSET_PX = 150;
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
  /** 手动微调叠加的位移（预览图拖拽后才有），供调试与审计识别。 */
  manualOffset?: LabelOffset;
  /** 无法完全避开禁入区或越出核心区时给出可定位的问题；正常时为 null。 */
  conflict: LabelConflict | null;
};

export type PlaceLabelInput = {
  /** 府的投影包围盒：决定水平中心，以及文字块的上下基准。 */
  bounds: LabelRect;
  /** 文字允许区域（中间核心区）。 */
  panelBounds: LabelRect;
  box?: {width: number; height: number};
  /** 右侧互动栏禁入区（已含额外间距）。null / 省略表示没有禁入区。 */
  keepOut?: LabelRect | null;
  /**
   * 已被前面标签占用的矩形（同一画面里先落位的那些）。所有读数常驻后，
   * 相邻小府的默认位会撞车：本标签在严格对齐的前提下，于上下各一个文字块
   * 高度内找完全不重叠的位置，取位移最小的那个。调用方必须按**固定顺序**
   * （名次先后）传入，渲染与预览审计才会得到同一份布局。
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
 * 纵向：块顶 = 府中心 − 府名行中心偏移，所以第二行府名的中心正好压在府中心。
 */
export const placeLabel = ({
  bounds,
  panelBounds,
  box = LABEL_BOX,
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

  // 纵向只有一条规则：第二行府名的中心 = 府的中心。
  // 府再矮也不改基准（旧实现的「府太矮就贴府顶起排」会把 83×56px 的曼谷
  // 整块推到府中心以下、溢出到海面），只在核心区边界上做 clamp。
  const minY = panelBounds.y0;
  const maxY = Math.max(minY, panelBounds.y1 - height);
  const anchoredY = cy - LABEL_NAME_CENTER_Y;
  const baseY = clamp(anchoredY, minY, maxY);
  let y0 = baseY;

  // 读数常驻后相邻小府会撞车：在**上下各一个文字块高度**内找完全错开的位置，
  // 优先位移最小、其次重叠面积最小；让不开就保持严格对齐（对齐优先于避让），
  // 残余重叠交给安全区审计如实报出。
  if (occupied.length > 0) {
    const candidates = new Set<number>([baseY]);
    for (const rect of occupied) {
      // 只有横向会撞上的块才需要用纵向错位来让开。
      if (rect.x1 <= x0 || rect.x0 >= x0 + width) continue;
      candidates.add(clamp(rect.y0 - height, minY, maxY));
      candidates.add(clamp(rect.y1, minY, maxY));
    }
    let best: {y: number; overlap: number; shift: number} | null = null;
    for (const candidateY of candidates) {
      const shift = Math.abs(candidateY - baseY);
      if (shift > MAX_AVOID_SHIFT_PX + 1e-9) continue;
      const panel = rectOf(x0, candidateY, width, height);
      const overlap = occupied.reduce((sum, rect) => sum + overlapArea(panel, rect), 0);
      if (
        !best ||
        overlap < best.overlap - 1e-9 ||
        (Math.abs(overlap - best.overlap) <= 1e-9 && shift < best.shift)
      ) {
        best = {y: candidateY, overlap, shift};
      }
    }
    if (best) y0 = best.y;
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

/* -------------------------------------------------------------------------- *
 * 手动微调（预览图里用鼠标拖动读数）
 *
 * 手动偏移是**叠加在自动落位结果之上**的像素位移：先按「府名中心 = 府中心」
 * 算好，再加 (dx, dy)。这样拖一格就是一格，不会因为重新走一遍避让而跳位。
 *
 * 上限 `MAX_MANUAL_OFFSET_PX` 是硬约束：拖过界（误操作、拖飞了）时校验直接
 * 判否，读数回落到自动落位——预览页会把方块弹回原位，成片也照同一规则，
 * 不可能出现「读数被拖到画面另一头」的视频。
 * -------------------------------------------------------------------------- */

export type LabelOffset = {dx: number; dy: number};
/** 以 provinceId（大写）为键的手动偏移表。 */
export type LabelOffsetMap = Record<string, LabelOffset>;

/** 偏移是否可用：有限数、单轴不超过 {@link MAX_MANUAL_OFFSET_PX}。 */
export const isLabelOffsetUsable = (offset: unknown): offset is LabelOffset => {
  if (!offset || typeof offset !== "object") return false;
  const {dx, dy} = offset as LabelOffset;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.abs(dx) <= MAX_MANUAL_OFFSET_PX && Math.abs(dy) <= MAX_MANUAL_OFFSET_PX;
};

/** 规整成整数偏移；不可用时返回 null（= 回到自动落位）。 */
export const normalizeLabelOffset = (offset: unknown): LabelOffset | null => {
  if (!isLabelOffsetUsable(offset)) return null;
  return {dx: Math.round(offset.dx), dy: Math.round(offset.dy)};
};

/**
 * 规整整张偏移表：键统一大写、去掉不可用项与零位移项。
 * 服务端（预览/生成）与渲染端都用这一份，所以「拖过界就回原位」两边一致。
 */
export const normalizeLabelOffsetMap = (raw: unknown): LabelOffsetMap => {
  const out: LabelOffsetMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(key ?? "").trim().toUpperCase();
    if (!id) continue;
    const offset = normalizeLabelOffset(value);
    if (!offset) continue;
    if (offset.dx === 0 && offset.dy === 0) continue;
    out[id] = offset;
  }
  return out;
};

/** 把手动偏移叠到自动落位结果上；无效偏移原样返回（自动落位）。 */
export const applyLabelOffset = (
  placement: LabelPlacement,
  offset: unknown,
): LabelPlacement => {
  const delta = normalizeLabelOffset(offset);
  if (!delta || (delta.dx === 0 && delta.dy === 0)) return placement;
  const rect = placement.panelRect;
  return {
    ...placement,
    panel: [placement.panel[0] + delta.dx, placement.panel[1] + delta.dy],
    panelRect: {
      x0: rect.x0 + delta.dx,
      y0: rect.y0 + delta.dy,
      x1: rect.x1 + delta.dx,
      y1: rect.y1 + delta.dy,
    },
    manualOffset: delta,
  };
};
