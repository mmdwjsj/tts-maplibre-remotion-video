/**
 * TikTok / 抖音竖屏 UI 安全区（safe area）。
 *
 * 发布到 TikTok、抖音后，手机播放界面会用自己的 UI 盖住画面的一部分：顶部
 * 状态栏与导航、右侧头像/点赞/评论/收藏/分享互动栏、底部账号 ID + 发布描述
 * + 话题标签 + 音频信息，以及底部系统导航栏。发布描述的长度不固定，底部被
 * 占用的高度也就跟着变，所以**不能**只留一条固定的底部边距。
 *
 * 这个模块把"哪些地方会被平台 UI 盖住"变成可配置、可计算、可验证的数据：
 *
 * 1. 分区只有四个：顶部导航、右侧互动栏、底部账号 ID 与描述、中间核心内容。
 *    配置（`src/config/safe-area.config.json`）里 TikTok 与抖音各有一套独立的
 *    四边预留 + 互动栏纵向范围，并带版本号，便于按真机截图校准。
 * 2. 发布描述按字符数落到 short / medium / long 三档，每档有自己的底部预留。
 * 3. 取景矩形就是中间核心区：`mapRect` 恒等于 `coreRect`（2026-11-07 合并）。
 *    `labelRect` / `interactiveRect` / `interactiveGapRect` / 四条 band 都是从
 *    这四个分区派生的几何量，不是分区：不写进配置、不画成预览里的第二个框。
 * 4. 四个分区的四条边界就是**唯一一组可调参数**（`request.coreMargins`）：
 *    上 / 下 / 左 / 右 = 核心框四条边距屏幕四边的像素。预览与成片把同一组
 *    值送给同一个 `resolveSafeArea`，所以只有一个矩形、只有一套来源。
 *    不传时按平台配置 + 发布描述分档派生，默认构图不受影响。
 * 5. 提供越界 / 禁入区相交 / 标签重叠检测，输出**可定位**的诊断（元素 id、
 *    所属组件、越界方向、越界像素），而不是静默隐藏内容。
 *
 * 重要：所有像素值都是**工程初始估值**，不是 TikTok 或抖音的官方统一规范。
 * TikTok 的广告规范不等于自然流视频的规范，TikTok 的参数也不能当作抖音的
 * 规范。换机型/换客户端版本后请按真实截图重新校准（`verified` 标记）。
 *
 * 本模块刻意保持零 import（连类型 import 都没有），这样 Node 可以直接执行
 * TypeScript（类型擦除）来跑 `scripts/safearea/safe-area.test.mjs`，服务端与
 * 渲染端也能加载**同一份**实现 —— 不复制第二套算法。
 */

/* -------------------------------------------------------------------------- *
 * 类型
 * -------------------------------------------------------------------------- */

export type SafePlatform = "tiktok" | "douyin";
export type DescriptionTierId = "short" | "medium" | "long";

export type SafeCanvas = {width: number; height: number};
export type SafeMargins = {top: number; bottom: number; left: number; right: number};
/** 与 `resolveViewport` 的 `FramingRect` 结构一致（纯数据，不需要 import）。 */
export type SafeRect = {x0: number; y0: number; x1: number; y1: number};
export type SafeKeepOut = {x: number; y: number; width: number; height: number};

/** 一条描述等级规则；`maxChars: null` 表示没有上限（该档兜底）。 */
export type SafeAreaTierRule = {
  tier: string;
  maxChars: number | null;
  bottomPx?: number;
};

export type ResolvedTierRule = {
  id: DescriptionTierId;
  tier: string;
  maxChars: number | null;
  bottomPx: number;
};

export type SafeAreaPlatformInput = {
  label?: string;
  verified?: boolean;
  margins?: Partial<SafeMargins>;
  /** 该平台在各描述等级下的底部预留（覆盖全局 tier 的 bottomPx）。 */
  bottomByTier?: Record<string, number>;
  /**
   * 右侧互动栏（四个分区之一）的纵向范围。`x` / `width` 由 `margins.right`
   * 推导，配置里不必写；旧配置仍可显式给 x/width，行为不变。
   */
  interactiveKeepOut?: Partial<SafeKeepOut> | null;
};

export type SafeAreaConfigInput = {
  version?: string;
  canvas?: Partial<SafeCanvas>;
  defaultPlatform?: string;
  contentGapPx?: number;
  descriptionTiers?: SafeAreaTierRule[];
  platforms?: Record<string, SafeAreaPlatformInput>;
};

export type ResolvedPlatform = {
  id: SafePlatform;
  label: string;
  verified: boolean;
  margins: SafeMargins;
  bottomByTier: Partial<Record<DescriptionTierId, number>>;
  interactiveKeepOut: SafeKeepOut | null;
};

export type ResolvedSafeAreaConfig = {
  version: string;
  canvas: SafeCanvas;
  defaultPlatform: SafePlatform;
  contentGapPx: number;
  tiers: ResolvedTierRule[];
  platforms: Record<SafePlatform, ResolvedPlatform>;
};

export type SafeAreaRequest = {
  platform?: unknown;
  /** 程序自动生成的**发布描述**，与视频内字幕是两回事。 */
  description?: unknown;
  /**
   * 四个分区的四条边界，也就是**唯一一个矩形（核心框）**的四条边距屏幕四边
   * 的像素：`{top, bottom, left, right}`。
   *
   * 这是唯一的构图参数入口：预览与成片把同一组值送给同一个 `resolveSafeArea`，
   * 核心框、取景矩形、四条压暗带、右侧互动栏横向全部从它派生，不存在第二套
   * 位移/间距叠加，也不存在「预览一个框、计算另一个框」。
   *
   * 传 `null` 或省略 = 完全按平台配置 + 发布描述分档派生（默认构图）。
   * 只传其中几条也可以，未提供的边仍走派生值。值必须是非负数，非法值回退
   * 派生值并逐条告警；超过画布 45% 的边由既有收敛逻辑处理。
   */
  coreMargins?: unknown;
};

export type DescriptionTierMatch = {
  id: DescriptionTierId;
  tier: string;
  maxChars: number | null;
  bottomPx: number;
  chars: number;
  /** 描述缺失时用的是默认档（short），会记一条警告。 */
  usedFallback: boolean;
  matchedBy: "chars" | "fallback-empty" | "fallback-unknown";
};

export type SafeAreaResolution = {
  version: string;
  /** 这批数值的来源：当前固定为工程初始估值，待真机验证。 */
  provenance: "initial-estimate";
  platform: SafePlatform;
  platformLabel: string;
  verified: boolean;
  canvas: SafeCanvas;
  margins: SafeMargins;
  /** 本次请求是否手动调过四分区边界（true 时四边以请求值为准，不再随描述分档）。 */
  coreMarginsApplied: boolean;
  /** 底部预留取自等级（tier）还是平台兜底（platform）。 */
  bottomSource: "tier" | "platform";
  contentGapPx: number;
  descriptionTier: DescriptionTierId;
  descriptionChars: number;
  description: string;
  tierRule: ResolvedTierRule;
  tiers: ResolvedTierRule[];
  /* 以下全是从四个分区派生的几何量，不是分区，也不进配置与预览。 */
  /** 中间核心内容区：标题、排名数字、区域名、图例、浮动标签都必须落在这里。 */
  coreRect: SafeRect;
  /**
   * 浮动标签允许区。**已并入 `coreRect`**（2026-11-07 简化）：不再单独内缩
   * `contentGapPx`，字段保留只为兼容既有调用方，值恒等于 `coreRect`。
   */
  labelRect: SafeRect;
  /** 右侧互动栏禁入区（画布坐标）。 */
  interactiveRect: SafeRect | null;
  /** 禁入区外扩 `contentGapPx`：重要内容的"实际禁入"范围。 */
  interactiveGapRect: SafeRect | null;
  /** 顶部 / 底部 / 左 / 右预留带，供调试遮罩绘制。 */
  topBandRect: SafeRect;
  bottomBandRect: SafeRect;
  leftBandRect: SafeRect;
  rightBandRect: SafeRect;
  /** 排名府外接矩形的取景目标。**恒等于 `coreRect`**：四分区只有一个矩形。 */
  mapRect: SafeRect;
  warnings: string[];
};

/* -------------------------------------------------------------------------- *
 * 默认配置（与 src/config/safe-area.config.json 保持一致）
 * -------------------------------------------------------------------------- */

/**
 * 配置缺失或非法时的安全兜底。数值刻意与随包配置一致，保证"没有配置文件"
 * 时仍然是一个可用的、保守的初始布局。
 */
export const SAFE_AREA_CONFIG_VERSION = "2026-11-07.4";

export const DEFAULT_SAFE_AREA_CONFIG: ResolvedSafeAreaConfig = {
  version: SAFE_AREA_CONFIG_VERSION,
  canvas: {width: 1080, height: 1920},
  defaultPlatform: "tiktok",
  contentGapPx: 5,
  tiers: [
    {id: "short", tier: "short", maxChars: 80, bottomPx: 480},
    {id: "medium", tier: "medium", maxChars: 200, bottomPx: 540},
    {id: "long", tier: "long", maxChars: null, bottomPx: 600},
  ],
  platforms: {
    tiktok: {
      id: "tiktok",
      label: "TikTok",
      verified: false,
      // 2026-11-07.4 起 TikTok 默认四边预留：上 100 / 下 150 / 左 10 / 右 10，
      // 三档描述统一压平为 150px。均为工程初始估值，不是平台官方规范。
      margins: {top: 100, bottom: 150, left: 10, right: 10},
      bottomByTier: {short: 150, medium: 150, long: 150},
      interactiveKeepOut: {x: 1070, y: 650, width: 10, height: 930},
    },
    douyin: {
      id: "douyin",
      label: "抖音",
      verified: false,
      margins: {top: 240, bottom: 480, left: 72, right: 180},
      bottomByTier: {short: 480, medium: 540, long: 600},
      interactiveKeepOut: {x: 900, y: 650, width: 180, height: 930},
    },
  },
};

/** 调试遮罩的 props 开关名：默认不存在，所以成片永远不会带遮罩。 */
export const SAFE_AREA_DEBUG_PROP = "debugSafeArea";

export const PLATFORM_IDS: SafePlatform[] = ["tiktok", "douyin"];

/* -------------------------------------------------------------------------- *
 * 小工具
 * -------------------------------------------------------------------------- */

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const rectWidth = (rect: SafeRect): number => rect.x1 - rect.x0;
export const rectHeight = (rect: SafeRect): number => rect.y1 - rect.y0;
export const rectArea = (rect: SafeRect): number =>
  Math.max(0, rectWidth(rect)) * Math.max(0, rectHeight(rect));

export const keepOutToRect = (keepOut: SafeKeepOut): SafeRect => ({
  x0: keepOut.x,
  y0: keepOut.y,
  x1: keepOut.x + keepOut.width,
  y1: keepOut.y + keepOut.height,
});

/** 四边同时内缩（负数即外扩）。结果保持非负宽高。 */
export const insetRect = (rect: SafeRect, inset: number): SafeRect => {
  const x0 = Math.min(rect.x0 + inset, rect.x1);
  const y0 = Math.min(rect.y0 + inset, rect.y1);
  const x1 = Math.max(rect.x0 + inset, rect.x1 - inset);
  const y1 = Math.max(rect.y0 + inset, rect.y1 - inset);
  return {x0, y0, x1, y1};
};

export const intersectRects = (a: SafeRect, b: SafeRect): SafeRect | null => {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  return x1 > x0 && y1 > y0 ? {x0, y0, x1, y1} : null;
};

export const rectsIntersect = (a: SafeRect, b: SafeRect): boolean =>
  intersectRects(a, b) !== null;

/** 完全包含（含相切）判断。 */
export const rectContains = (outer: SafeRect, inner: SafeRect): boolean =>
  inner.x0 >= outer.x0 &&
  inner.y0 >= outer.y0 &&
  inner.x1 <= outer.x1 &&
  inner.y1 <= outer.y1;

/* -------------------------------------------------------------------------- *
 * 配置归一化
 * -------------------------------------------------------------------------- */

const readMargins = (
  raw: unknown,
  fallback: SafeMargins,
  label: string,
  warnings: string[],
): SafeMargins => {
  const input = readObject(raw);
  const read = (key: keyof SafeMargins): number => {
    const value = input[key];
    if (value === undefined) return fallback[key];
    if (!isFiniteNumber(value) || value < 0) {
      warnings.push(
        `${label}.margins.${key} 必须是非负数（收到 ${String(value)}），已回退为 ${fallback[key]}`,
      );
      return fallback[key];
    }
    return value;
  };
  return {top: read("top"), bottom: read("bottom"), left: read("left"), right: read("right")};
};

const readKeepOut = (
  raw: unknown,
  fallback: SafeKeepOut | null,
  label: string,
  warnings: string[],
): SafeKeepOut | null => {
  if (raw === null) return null;
  if (raw === undefined) return fallback;
  const input = readObject(raw);
  const keys: Array<keyof SafeKeepOut> = ["x", "y", "width", "height"];
  const values: Partial<SafeKeepOut> = {};
  for (const key of keys) {
    const value = input[key];
    if (value === undefined) {
      if (!fallback) {
        warnings.push(`${label}.interactiveKeepOut.${key} 缺失且没有默认值，已忽略禁入区`);
        return null;
      }
      values[key] = fallback[key];
      continue;
    }
    if (!isFiniteNumber(value) || value < 0) {
      warnings.push(
        `${label}.interactiveKeepOut.${key} 必须是非负数（收到 ${String(value)}），已回退为 ${fallback ? fallback[key] : 0}`,
      );
      values[key] = fallback ? fallback[key] : 0;
      continue;
    }
    values[key] = value;
  }
  const keepOut: SafeKeepOut = {
    x: values.x ?? 0,
    y: values.y ?? 0,
    width: values.width ?? 0,
    height: values.height ?? 0,
  };
  if (keepOut.width <= 0 || keepOut.height <= 0) {
    warnings.push(`${label}.interactiveKeepOut 宽高必须大于 0，已忽略禁入区`);
    return null;
  }
  return keepOut;
};

/**
 * 校验并补全用户配置。任何非法值都不会产生坏布局：回退到默认值并记录警告，
 * 调用方负责把警告写进日志 / UI。
 */
export const normalizeSafeAreaConfig = (
  raw?: unknown,
): {config: ResolvedSafeAreaConfig; warnings: string[]} => {
  const warnings: string[] = [];
  const input = readObject(raw);
  const base = DEFAULT_SAFE_AREA_CONFIG;

  const version =
    typeof input.version === "string" && input.version.trim()
      ? input.version.trim()
      : base.version;

  const canvasInput = readObject(input.canvas);
  const readCanvasSide = (key: "width" | "height"): number => {
    const value = canvasInput[key];
    if (value === undefined) return base.canvas[key];
    if (!isFiniteNumber(value) || value < 240) {
      warnings.push(
        `canvas.${key} 异常（${String(value)}），已回退为 ${base.canvas[key]}`,
      );
      return base.canvas[key];
    }
    return value;
  };
  const canvas: SafeCanvas = {
    width: readCanvasSide("width"),
    height: readCanvasSide("height"),
  };

  const defaultPlatform: SafePlatform =
    input.defaultPlatform === "douyin"
      ? "douyin"
      : input.defaultPlatform === "tiktok"
        ? "tiktok"
        : base.defaultPlatform;
  if (
    input.defaultPlatform !== undefined &&
    input.defaultPlatform !== "tiktok" &&
    input.defaultPlatform !== "douyin"
  ) {
    warnings.push(
      `defaultPlatform 取值非法（${String(input.defaultPlatform)}），已回退为 ${base.defaultPlatform}`,
    );
  }

  const contentGapPx =
    isFiniteNumber(input.contentGapPx) && input.contentGapPx >= 0
      ? input.contentGapPx
      : base.contentGapPx;
  if (input.contentGapPx !== undefined && contentGapPx !== input.contentGapPx) {
    warnings.push(
      `contentGapPx 必须是非负数（收到 ${String(input.contentGapPx)}），已回退为 ${base.contentGapPx}`,
    );
  }

  /* 描述等级：边界值可改，但必须单调递增且最后一档没有上限。 */
  let tiers: ResolvedTierRule[] = base.tiers.map((tier) => ({...tier}));
  if (input.descriptionTiers !== undefined) {
    const list = Array.isArray(input.descriptionTiers) ? input.descriptionTiers : null;
    if (!list || !list.length) {
      warnings.push("descriptionTiers 必须是至少一项的数组，已回退为默认 short/medium/long");
    } else {
      const parsed: ResolvedTierRule[] = [];
      list.forEach((entry, index) => {
        const item = readObject(entry);
        const id = item.tier;
        if (id !== "short" && id !== "medium" && id !== "long") {
          warnings.push(
            `descriptionTiers[${index}].tier 取值非法（${String(id)}），已跳过该档`,
          );
          return;
        }
        const maxChars =
          item.maxChars === null
            ? null
            : isFiniteNumber(item.maxChars) && item.maxChars > 0
              ? item.maxChars
              : undefined;
        if (maxChars === undefined) {
          warnings.push(
            `descriptionTiers[${index}].maxChars 必须是正数或 null（收到 ${String(item.maxChars)}），已跳过该档`,
          );
          return;
        }
        const fallbackBottom =
          base.tiers.find((tier) => tier.id === id)?.bottomPx ?? base.contentGapPx;
        const bottomPx =
          isFiniteNumber(item.bottomPx) && item.bottomPx >= 0
            ? item.bottomPx
            : fallbackBottom;
        if (item.bottomPx !== undefined && bottomPx !== item.bottomPx) {
          warnings.push(
            `descriptionTiers[${index}].bottomPx 必须是非负数（收到 ${String(item.bottomPx)}），已回退为 ${fallbackBottom}`,
          );
        }
        parsed.push({id, tier: String(id), maxChars, bottomPx});
      });
      if (parsed.length) tiers = parsed;
    }
  }
  tiers = tiers
    .slice()
    .sort((a, b) => (a.maxChars ?? Number.POSITIVE_INFINITY) - (b.maxChars ?? Number.POSITIVE_INFINITY));
  if (!tiers.length) {
    tiers = base.tiers.map((tier) => ({...tier}));
    warnings.push("descriptionTiers 为空，已回退为默认 short/medium/long");
  }
  const unbounded = tiers.filter((tier) => tier.maxChars === null);
  if (!unbounded.length) {
    warnings.push("descriptionTiers 缺少 maxChars=null 的兜底档，超长描述将落到最后一档");
  }

  /* 平台：两套互相独立，缺一个就用默认值补齐（不会串到另一个平台）。 */
  const platformsInput = readObject(input.platforms);
  const platforms = {} as Record<SafePlatform, ResolvedPlatform>;
  for (const id of PLATFORM_IDS) {
    const fallback = base.platforms[id];
    if (platformsInput[id] === undefined) {
      if (input.platforms !== undefined) {
        warnings.push(`platforms.${id} 缺失，已使用默认的 ${id} 初始估值`);
      }
      platforms[id] = {
        ...fallback,
        margins: {...fallback.margins},
        bottomByTier: {...fallback.bottomByTier},
        interactiveKeepOut: fallback.interactiveKeepOut
          ? {
              // 同下面显式配置的分支：横向由右边距推导，不抄写死的 x/width。
              x: Math.max(0, canvas.width - fallback.margins.right),
              width: Math.min(fallback.margins.right, canvas.width),
              y: fallback.interactiveKeepOut.y,
              height: fallback.interactiveKeepOut.height,
            }
          : null,
      };
      continue;
    }
    const platformInput = readObject(platformsInput[id]) as SafeAreaPlatformInput;
    const margins = readMargins(
      platformInput.margins,
      fallback.margins,
      `platforms.${id}`,
      warnings,
    );
    const bottomByTier: Partial<Record<DescriptionTierId, number>> = {};
    for (const tier of tiers) {
      const override = readObject(platformInput.bottomByTier)[tier.id];
      if (override === undefined) continue;
      if (isFiniteNumber(override) && override >= 0) {
        bottomByTier[tier.id] = override;
      } else {
        warnings.push(
          `platforms.${id}.bottomByTier.${tier.id} 必须是非负数（收到 ${String(override)}），已忽略`,
        );
      }
    }
    /*
     * 互动栏的横向位置与宽度不再单独写死：它就是「画布右边距那一条」。
     * 配置里只保留纵向范围（y / height），x 与 width 由 margins.right 推导，
     * 避免同一个事实（右边 180px 是互动栏）在两处出现、改一处漏一处。
     */
    const keepOutBase = fallback.interactiveKeepOut;
    const keepOutFallback: SafeKeepOut | null = keepOutBase
      ? {
          x: Math.max(0, canvas.width - margins.right),
          width: Math.min(margins.right, canvas.width),
          y: keepOutBase.y,
          height: keepOutBase.height,
        }
      : null;
    platforms[id] = {
      id,
      label:
        typeof platformInput.label === "string" && platformInput.label.trim()
          ? platformInput.label.trim()
          : fallback.label,
      verified: platformInput.verified === true,
      margins,
      bottomByTier,
      interactiveKeepOut: readKeepOut(
        platformInput.interactiveKeepOut,
        keepOutFallback,
        `platforms.${id}`,
        warnings,
      ),
    };
  }

  return {
    config: {version, canvas, defaultPlatform, contentGapPx, tiers, platforms},
    warnings,
  };
};

/* -------------------------------------------------------------------------- *
 * 描述等级
 * -------------------------------------------------------------------------- */

/**
 * 按发布描述字符数选等级。
 *
 * 字符数只用于**初步选择配置**，不代表真实 UI 高度：泰语、中文、英文、表情
 * 与换行的排版宽度都不同，所以这只是起点，真正的参数要靠真机截图校准。
 * 描述缺失（空/未提供）时使用默认的 short 档并给出警告。
 */
export const selectDescriptionTier = (
  description: unknown,
  tiers: ResolvedTierRule[],
): DescriptionTierMatch => {
  const rules = tiers.length ? tiers : DEFAULT_SAFE_AREA_CONFIG.tiers;
  const fallbackRule = rules.find((rule) => rule.id === "short") ?? rules[0];
  const text = typeof description === "string" ? description : "";
  const chars = Array.from(text).length;

  if (!chars) {
    return {
      id: fallbackRule.id,
      tier: fallbackRule.tier,
      maxChars: fallbackRule.maxChars,
      bottomPx: fallbackRule.bottomPx,
      chars: 0,
      usedFallback: true,
      matchedBy: "fallback-empty",
    };
  }

  const matched =
    rules.find((rule) => rule.maxChars !== null && chars <= rule.maxChars) ??
    rules.filter((rule) => rule.maxChars === null).pop() ??
    rules[rules.length - 1];

  return {
    id: matched.id,
    tier: matched.tier,
    maxChars: matched.maxChars,
    bottomPx: matched.bottomPx,
    chars,
    usedFallback: false,
    matchedBy: "chars",
  };
};

/* -------------------------------------------------------------------------- *
 * resolveSafeArea
 * -------------------------------------------------------------------------- */

/**
 * 读取请求级的四分区边界覆盖（唯一一组可调参数）。
 *
 * 只有非负有限数才接受；非法值逐条告警并忽略该边，绝不让坏值生出坏布局。
 * 返回 `null` 表示这次请求没有手动调整 —— 四边全部按平台配置 + 描述分档派生。
 */
const readCoreMarginOverrides = (
  raw: unknown,
  warnings: string[],
): Partial<SafeMargins> | null => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("coreMargins 必须是 {top,bottom,left,right} 对象，已忽略");
    return null;
  }
  const input = readObject(raw);
  const overrides: Partial<SafeMargins> = {};
  let count = 0;
  (["top", "bottom", "left", "right"] as const).forEach((side) => {
    const value = input[side];
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "number" && typeof value !== "string") {
      warnings.push(`coreMargins.${side} 必须是非负数（收到 ${String(value)}），已忽略`);
      return;
    }
    const num = typeof value === "number" ? value : Number(value);
    if (!isFiniteNumber(num) || num < 0) {
      warnings.push(`coreMargins.${side} 必须是非负数（收到 ${String(value)}），已忽略`);
      return;
    }
    overrides[side] = num;
    count += 1;
  });
  return count ? overrides : null;
};

const bandRects = (
  canvas: SafeCanvas,
  core: SafeRect,
  margins: SafeMargins,
): Pick<
  SafeAreaResolution,
  "topBandRect" | "bottomBandRect" | "leftBandRect" | "rightBandRect"
> => ({
  topBandRect: {x0: 0, y0: 0, x1: canvas.width, y1: margins.top},
  bottomBandRect: {
    x0: 0,
    y0: canvas.height - margins.bottom,
    x1: canvas.width,
    y1: canvas.height,
  },
  leftBandRect: {x0: 0, y0: margins.top, x1: margins.left, y1: canvas.height - margins.bottom},
  rightBandRect: {
    x0: canvas.width - margins.right,
    y0: margins.top,
    x1: canvas.width,
    y1: canvas.height - margins.bottom,
  },
});

/**
 * 解析一次发布请求的安全区。
 *
 * `request.platform` 决定用哪套平台配置（非法值回退到 `defaultPlatform` 并
 * 警告），`request.description` 是**发布描述**（不是视频内字幕），用于选
 * short / medium / long。
 */
export const resolveSafeArea = (
  rawConfig: unknown,
  request: SafeAreaRequest = {},
): SafeAreaResolution => {
  const {config, warnings} = normalizeSafeAreaConfig(rawConfig);
  const canvas = config.canvas;

  const requestedPlatform = request.platform;
  let platform: SafePlatform = config.defaultPlatform;
  if (requestedPlatform !== undefined && requestedPlatform !== null && requestedPlatform !== "") {
    if (requestedPlatform === "tiktok" || requestedPlatform === "douyin") {
      platform = requestedPlatform;
    } else {
      warnings.push(
        `平台取值非法（${String(requestedPlatform)}），已回退为 ${config.defaultPlatform}`,
      );
    }
  }
  const platformConfig = config.platforms[platform];

  const tier = selectDescriptionTier(request.description, config.tiers);
  if (tier.usedFallback) {
    warnings.push(
      "发布描述缺失，安全区已使用默认的 short 档（底部预留 " +
        `${config.platforms[platform].bottomByTier.short ?? tier.bottomPx}px）`,
    );
  }

  const tierBottom = platformConfig.bottomByTier[tier.id];
  const bottomPx = tierBottom ?? tier.bottomPx;
  const bottomSource: "tier" | "platform" = tierBottom === undefined ? "tier" : "platform";

  const margins: SafeMargins = {
    top: platformConfig.margins.top,
    bottom: bottomPx,
    left: platformConfig.margins.left,
    right: platformConfig.margins.right,
  };

  // 四个分区的四条边界 = 唯一一组可调参数，也是唯一一个矩形（核心框）的四边。
  // 覆盖放在描述分档之后：手动值优先于 tier 的 bottomPx，不会出现「调了下边
  // 却被描述等级改回去」。预览与成片把同一组值送给同一个 resolveSafeArea，
  // 所以核心框、取景矩形、四条压暗带、互动栏横向永远来自同一套来源。
  const coreMarginOverrides = readCoreMarginOverrides(request.coreMargins, warnings);
  if (coreMarginOverrides) {
    (["top", "bottom", "left", "right"] as const).forEach((side) => {
      const value = coreMarginOverrides[side];
      if (value !== undefined) margins[side] = value;
    });
  }

  // 预留不能把画面吃光：任何一边超过画布的 45% 都收敛并报警。
  const limitY = Math.floor(canvas.height * 0.45);
  const limitX = Math.floor(canvas.width * 0.45);
  (["top", "bottom"] as const).forEach((side) => {
    if (margins[side] > limitY) {
      warnings.push(
        `${platform} 的${side}预留 ${margins[side]}px 超过画布高度 45%，已收敛为 ${limitY}px`,
      );
      margins[side] = limitY;
    }
  });
  (["left", "right"] as const).forEach((side) => {
    if (margins[side] > limitX) {
      warnings.push(
        `${platform} 的${side}预留 ${margins[side]}px 超过画布宽度 45%，已收敛为 ${limitX}px`,
      );
      margins[side] = limitX;
    }
  });

  /* 右侧互动栏禁入区先算出来：核心安全区要按它 + 额外间距收敛。 */
  const configuredKeepOut = platformConfig.interactiveKeepOut;
  // 右侧互动栏是四个分区之一，横向范围恒等于「右边距那一条」。手动调过右边距
  // 时它必须跟着走，否则核心框右边界仍会被配置里固化的旧 x/width 收敛，出现
  // 「调了右边却没反应」。未手动调整时保持配置原样（含旧配置显式 x/width）。
  const rawKeepOut =
    configuredKeepOut && coreMarginOverrides?.right !== undefined
      ? {
          ...configuredKeepOut,
          x: Math.max(0, canvas.width - margins.right),
          width: Math.min(margins.right, canvas.width),
        }
      : configuredKeepOut;
  let interactiveRect: SafeRect | null = null;
  let interactiveGapRect: SafeRect | null = null;
  if (rawKeepOut) {
    const candidate = keepOutToRect(rawKeepOut);
    const clipped: SafeRect = {
      x0: clamp(candidate.x0, 0, canvas.width),
      y0: clamp(candidate.y0, 0, canvas.height),
      x1: clamp(candidate.x1, 0, canvas.width),
      y1: clamp(candidate.y1, 0, canvas.height),
    };
    if (rectWidth(clipped) <= 0 || rectHeight(clipped) <= 0) {
      warnings.push(`${platform} 的右侧互动栏禁入区完全落在画布之外，已忽略`);
    } else {
      if (
        clipped.x0 !== candidate.x0 ||
        clipped.y0 !== candidate.y0 ||
        clipped.x1 !== candidate.x1 ||
        clipped.y1 !== candidate.y1
      ) {
        warnings.push(
          `${platform} 的右侧互动栏禁入区超出画布，已裁到画布范围内：` +
            `x ${clipped.x0}~${clipped.x1}, y ${clipped.y0}~${clipped.y1}`,
        );
      }
      interactiveRect = clipped;
      interactiveGapRect = {
        x0: clipped.x0 - config.contentGapPx,
        y0: clipped.y0 - config.contentGapPx,
        x1: clipped.x1 + config.contentGapPx,
        y1: clipped.y1 + config.contentGapPx,
      };
    }
  }

  const coreRect: SafeRect = {
    x0: margins.left,
    y0: margins.top,
    x1: canvas.width - margins.right,
    y1: canvas.height - margins.bottom,
  };
  // 四边预留之外，重要内容还要与禁入区保持 `contentGapPx` 间距：禁入区贴在
  // 画布右边缘（互动栏就是这么贴着的）时，核心安全区的右边界要收到禁入区
  // 左侧再退一个间距，否则贴着边界的内容会正好落进那段间距里。
  if (interactiveRect) {
    const gap = config.contentGapPx;
    if (interactiveRect.x1 >= canvas.width - 1e-6) {
      coreRect.x1 = Math.min(coreRect.x1, Math.max(coreRect.x0, interactiveRect.x0 - gap));
    } else if (interactiveRect.x0 <= 1e-6) {
      coreRect.x0 = Math.max(coreRect.x0, Math.min(coreRect.x1, interactiveRect.x1 + gap));
    }
    if (interactiveRect.y1 >= canvas.height - 1e-6) {
      coreRect.y1 = Math.min(coreRect.y1, Math.max(coreRect.y0, interactiveRect.y0 - gap));
    } else if (interactiveRect.y0 <= 1e-6) {
      coreRect.y0 = Math.max(coreRect.y0, Math.min(coreRect.y1, interactiveRect.y1 + gap));
    }
  }
  if (rectWidth(coreRect) <= 0 || rectHeight(coreRect) <= 0) {
    warnings.push(
      `${platform} 的四边预留把核心安全区压成了空矩形，已回退为画布内缩 10%`,
    );
    const fallbackTop = Math.round(canvas.height * 0.1);
    const fallbackLeft = Math.round(canvas.width * 0.1);
    coreRect.x0 = fallbackLeft;
    coreRect.y0 = fallbackTop;
    coreRect.x1 = canvas.width - fallbackLeft;
    coreRect.y1 = canvas.height - fallbackTop;
    margins.top = fallbackTop;
    margins.bottom = fallbackTop;
    margins.left = fallbackLeft;
    margins.right = fallbackLeft;
  }

  // 浮动标签直接以核心安全区为边界。以前这里会再内缩 contentGapPx 形成一个
  // 独立的「标签安全区」，比核心区小 5px —— 5px 肉眼看不出来，却多了一条
  // 调试虚线、一处校准参数和一条审计分支，已于 2026-11-07 合并。
  const labelRect: SafeRect = {...coreRect};

  return {
    version: config.version,
    provenance: "initial-estimate",
    platform,
    platformLabel: platformConfig.label,
    verified: platformConfig.verified,
    canvas,
    margins,
    coreMarginsApplied: coreMarginOverrides !== null,
    bottomSource,
    contentGapPx: config.contentGapPx,
    descriptionTier: tier.id,
    descriptionChars: tier.chars,
    description: typeof request.description === "string" ? request.description : "",
    tierRule: {id: tier.id, tier: tier.tier, maxChars: tier.maxChars, bottomPx: tier.bottomPx},
    tiers: config.tiers.map((rule) => ({...rule})),
    coreRect,
    labelRect,
    interactiveRect,
    interactiveGapRect,
    ...bandRects(canvas, coreRect, margins),
    // 2026-11-07 合并：取景矩形 = 中间核心区。原本 mapRect 比 coreRect 大一圈
    // （靠底图出血参数吃进上/下预留带把瘦高的泰国地图撑宽），于是预览里出现
    // 「文字边界」与「地图形状边界」两个框。现在四分区就是唯一事实：排名府
    // 与文字都装进同一个矩形，页面只画一个框，底图出血参数随之删除。
    mapRect: {...coreRect},
    warnings,
  };
};

/* -------------------------------------------------------------------------- *
 * 越界 / 禁入区 / 重叠检测
 * -------------------------------------------------------------------------- */

export type SafeElementKind = "map" | "text" | "panel" | "marker" | "overlay";

export type SafeElement = {
  /** 可定位 id，如 `label:TH-10`。 */
  id: string;
  /** 产生这个元素的组件，如 `ThailandMap/placeLabel`。 */
  component: string;
  rect: SafeRect;
  kind?: SafeElementKind;
  /** 该元素额外要求的安全间距，不传则用安全区的 `contentGapPx`。 */
  gapPx?: number;
  /**
   * 允许进入禁入区：地图底图、装饰性元素为 true；
   * 标题、排名数字、区域名、图例、浮动标签都必须是 false（默认）。
   */
  allowKeepOut?: boolean;
};

export type SafeIssueCode =
  | "OUT_OF_CORE"
  | "IN_KEEP_OUT"
  | "OUT_OF_LABEL_RECT"
  | "LABEL_OVERLAP";

export type SafeDirection = "left" | "right" | "top" | "bottom";

export type SafeIssue = {
  code: SafeIssueCode;
  severity: "warning" | "error";
  elementId: string;
  component: string;
  rect: SafeRect;
  /** 越界 / 冲突方向。 */
  directions: SafeDirection[];
  /** 越出安全矩形的最大像素数（0 表示没越界）。 */
  overflowPx: number;
  detail: string;
};

/** 元素相对安全矩形的越界情况（带额外间距）。 */
export const checkBounds = (
  element: SafeElement,
  bounds: SafeRect,
  gapPx = 0,
): SafeIssue | null => {
  const directions: SafeDirection[] = [];
  let overflow = 0;
  const measure = (value: number): number => {
    overflow = Math.max(overflow, Math.round(value));
    return value;
  };
  if (element.rect.x0 < bounds.x0 - gapPx) {
    directions.push("left");
    measure(bounds.x0 - gapPx - element.rect.x0);
  }
  if (element.rect.x1 > bounds.x1 + gapPx) {
    directions.push("right");
    measure(element.rect.x1 - (bounds.x1 + gapPx));
  }
  if (element.rect.y0 < bounds.y0 - gapPx) {
    directions.push("top");
    measure(bounds.y0 - gapPx - element.rect.y0);
  }
  if (element.rect.y1 > bounds.y1 + gapPx) {
    directions.push("bottom");
    measure(element.rect.y1 - (bounds.y1 + gapPx));
  }
  if (!directions.length) return null;

  return {
    code: "OUT_OF_CORE",
    severity: overflow > 24 ? "error" : "warning",
    elementId: element.id,
    component: element.component,
    rect: {...element.rect},
    directions,
    overflowPx: overflow,
    detail:
      `${element.id}（${element.component}）越出安全区 ${directions.join("/")} ` +
      `方向 ${overflow}px（元素 x ${Math.round(element.rect.x0)}~${Math.round(element.rect.x1)}, ` +
      `y ${Math.round(element.rect.y0)}~${Math.round(element.rect.y1)}；` +
      `安全区 x ${Math.round(bounds.x0)}~${Math.round(bounds.x1)}, y ${Math.round(bounds.y0)}~${Math.round(bounds.y1)}）`,
  };
};

/** 元素与右侧互动栏禁入区（外扩间距版）相交。 */
export const checkKeepOut = (
  element: SafeElement,
  keepOutRect: SafeRect | null,
): SafeIssue | null => {
  if (!keepOutRect || element.allowKeepOut) return null;
  const overlap = intersectRects(element.rect, keepOutRect);
  if (!overlap) return null;
  const width = Math.round(rectWidth(overlap));
  const height = Math.round(rectHeight(overlap));
  return {
    code: "IN_KEEP_OUT",
    severity: "error",
    elementId: element.id,
    component: element.component,
    rect: {...element.rect},
    directions: ["right"],
    overflowPx: Math.max(width, height),
    detail:
      `${element.id}（${element.component}）与右侧互动栏禁入区重叠 ` +
      `${width}x${height}px（重叠区 x ${Math.round(overlap.x0)}~${Math.round(overlap.x1)}, ` +
      `y ${Math.round(overlap.y0)}~${Math.round(overlap.y1)}）`,
  };
};

/** 两个元素（通常是两个排名标签）是否重叠。 */
export const checkOverlap = (
  a: SafeElement,
  b: SafeElement,
  gapPx = 0,
): SafeIssue | null => {
  const expanded: SafeRect = {
    x0: b.rect.x0 - gapPx,
    y0: b.rect.y0 - gapPx,
    x1: b.rect.x1 + gapPx,
    y1: b.rect.y1 + gapPx,
  };
  const overlap = intersectRects(a.rect, expanded);
  if (!overlap) return null;
  const width = Math.round(rectWidth(overlap));
  const height = Math.round(rectHeight(overlap));
  return {
    code: "LABEL_OVERLAP",
    severity: "warning",
    elementId: a.id,
    component: a.component,
    rect: {...a.rect},
    directions: [],
    overflowPx: Math.max(width, height),
    detail:
      `${a.id} 与 ${b.id} 重叠 ${width}x${height}px` +
      (gapPx ? `（已含 ${gapPx}px 间距要求）` : "") +
      `：x ${Math.round(overlap.x0)}~${Math.round(overlap.x1)}, y ${Math.round(overlap.y0)}~${Math.round(overlap.y1)}`,
  };
};

/* -------------------------------------------------------------------------- *
 * 统一审计
 * -------------------------------------------------------------------------- */

export type SafeAreaAudit = {
  platform: SafePlatform;
  descriptionTier: DescriptionTierId;
  /** 每个元素单独过一遍：越界 + 禁入区。 */
  issues: SafeIssue[];
  /** 两两重叠（`kind === 'panel'` 的元素之间）。 */
  overlaps: SafeIssue[];
  /** 进不了安全区的元素 id，方便调用方决定是否调整标签或视野。 */
  violatingIds: string[];
  ok: boolean;
  /** 可直接打印的诊断行。 */
  lines: string[];
};

export type SafeAreaLayout = {
  resolution: SafeAreaResolution;
  elements: SafeElement[];
  /** 标签之间的最小间距要求，默认取 `contentGapPx`。 */
  labelGapPx?: number;
};

/**
 * 一次算完所有检查。
 *
 * 结果只报告，不静默处理：调用方（渲染日志 / UI）必须能看到哪个元素越界、
 * 往哪个方向越、越了多少，再决定是挪标签、调视野还是（最后才）缩字号。
 */
export const auditSafeAreaLayout = ({
  resolution,
  elements,
  labelGapPx,
}: SafeAreaLayout): SafeAreaAudit => {
  const issues: SafeIssue[] = [];
  const violations = elements
    .filter((element) => element.kind !== "map")
    .map((element) => {
      const gap = element.gapPx ?? resolution.contentGapPx;
      const bounds = element.kind === "panel" ? resolution.labelRect : resolution.coreRect;
      const boundsIssue = checkBounds(element, bounds, gap);
      if (boundsIssue && element.kind === "panel") {
        boundsIssue.code = "OUT_OF_LABEL_RECT";
      }
      const keepOutIssue = checkKeepOut(element, resolution.interactiveGapRect);
      return [boundsIssue, keepOutIssue].filter(
        (issue): issue is SafeIssue => issue !== null,
      );
    })
    .flat();

  issues.push(...violations);

  const panels = elements.filter((element) => element.kind === "panel");
  const overlaps: SafeIssue[] = [];
  const gap = labelGapPx ?? resolution.contentGapPx;
  for (let i = 0; i < panels.length; i += 1) {
    for (let j = i + 1; j < panels.length; j += 1) {
      const issue = checkOverlap(panels[i], panels[j], gap);
      if (issue) overlaps.push(issue);
    }
  }

  const violatingIds = Array.from(
    new Set([...issues, ...overlaps].map((issue) => issue.elementId)),
  );

  const lines = [
    ...issues.map((issue) => `${issue.severity === "error" ? "错误" : "警告"}：${issue.detail}`),
    ...overlaps.map((issue) => `警告：${issue.detail}`),
  ];

  return {
    platform: resolution.platform,
    descriptionTier: resolution.descriptionTier,
    issues,
    overlaps,
    violatingIds,
    ok: issues.length === 0 && overlaps.length === 0,
    lines,
  };
};

/* -------------------------------------------------------------------------- *
 * 日志 / 调试遮罩
 * -------------------------------------------------------------------------- */

const rectLine = (label: string, rect: SafeRect): string =>
  `${label} x ${Math.round(rect.x0)}~${Math.round(rect.x1)}（宽 ${Math.round(
    rectWidth(rect),
  )}）, y ${Math.round(rect.y0)}~${Math.round(rect.y1)}（高 ${Math.round(rectHeight(rect))}）`;

/** 人类可读的安全区摘要，直接进生成日志与 UI。 */
export const describeSafeArea = (resolution: SafeAreaResolution): string[] => {
  const lines = [
    `分区：顶部导航 / 右侧互动栏 / 底部账号ID与描述 / 中间核心内容（其余矩形均由这四区派生）`,
    `平台 ${resolution.platformLabel}（${resolution.platform}）· 安全区配置版本 ${resolution.version} · ` +
      `参数来源：${resolution.coreMarginsApplied ? "请求手动调整四分区边界" : "工程初始估值"}${
        resolution.verified ? "" : "（尚未用真机截图校准）"
      }`,
    `发布描述 ${resolution.descriptionChars} 字符 → 等级 ${resolution.descriptionTier}` +
      (resolution.tierRule.maxChars === null
        ? "（无上限档）"
        : `（≤ ${resolution.tierRule.maxChars} 字符）`) +
      ` · 底部预留 ${resolution.margins.bottom}px（来自${resolution.bottomSource === "platform" ? "平台覆盖" : "等级配置"}）`,
    `四边预留（核心框四条边）：上 ${resolution.margins.top} / 下 ${resolution.margins.bottom} / 左 ${resolution.margins.left} / 右 ${resolution.margins.right}（间距 ${resolution.contentGapPx}px）${resolution.coreMarginsApplied ? " · 手动调整" : ""}`,
    rectLine("核心安全区（也是取景矩形）", resolution.coreRect),
  ];
  if (resolution.interactiveRect) {
    lines.push(
      rectLine("右侧互动栏禁入区", resolution.interactiveRect) +
        `（含 ${resolution.contentGapPx}px 间距后 ` +
        rectLine("", resolution.interactiveGapRect ?? resolution.interactiveRect).trim() +
        "）",
    );
  } else {
    lines.push("右侧互动栏禁入区：未配置");
  }
  return [...lines, ...resolution.warnings.map((warning) => `警告：${warning}`)];
};

/**
 * 调试遮罩是否开启。
 *
 * 只有显式传 `debugSafeArea: true` 才会画遮罩；正式导出用的 render props 里
 * 不写这个字段，所以 MP4 永远不会把遮罩、边框或安全区文字烧进去。
 */
export const isDebugOverlayEnabled = (project: unknown): boolean =>
  readObject(project)[SAFE_AREA_DEBUG_PROP] === true;
