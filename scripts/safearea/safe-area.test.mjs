/**
 * TikTok / 抖音 UI 安全区测试。
 *
 * Run with: npm run test:safe-area
 *
 * 覆盖任务文档要求的 12 个场景：TikTok / 抖音 × short / medium / long 六种组合，
 * 标签贴最左、贴最右、压在底部安全区边缘、两个标签重叠，泰/中/英混合描述，以及
 * 空描述、超长描述与异常配置。另外覆盖安全区接入取景后的行为，以及"正式渲染
 * 不含调试遮罩"。
 *
 * 测试直接加载 `src/safearea/safeArea.ts`、`src/video/layout/labelPlacement.ts`
 * 和 `src/framing/resolveViewport.ts`（Node 类型擦除），并读**真实的**
 * `src/config/safe-area.config.json`，所以测的是运行中的那一份实现与配置。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  DEFAULT_SAFE_AREA_CONFIG,
  auditSafeAreaLayout,
  checkBounds,
  checkKeepOut,
  checkOverlap,
  describeSafeArea,
  isDebugOverlayEnabled,
  normalizeSafeAreaConfig,
  resolveSafeArea,
  selectDescriptionTier,
} from '../../src/safearea/safeArea.ts';
import {
  LABEL_BOX,
  labelFitsBounds,
  placeLabel,
} from '../../src/video/layout/labelPlacement.ts';
import {
  MAP_OVERLAY_BANDS,
  MAP_SAFE_INSET,
  MAP_STAGE,
  resolveViewport,
} from '../../src/framing/resolveViewport.ts';
import {loadSafeAreaConfig} from './load-safe-area-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(root, 'src', 'config', 'safe-area.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const geojson = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'data', 'thailand-provinces.geo.json'), 'utf8'),
);

const EAST = ['TH-10', 'TH-11', 'TH-13', 'TH-20', 'TH-21', 'TH-22', 'TH-23'];

/** 描述样例：字符数 -> 期望等级（边界值来自配置文件，不是硬编码的猜测）。 */
const TIER_CASES = [
  ['short', 20, 480],
  ['medium', 120, 540],
  ['long', 260, 600],
];

const PLATFORMS = ['tiktok', 'douyin'];

const overlaps = (a, b) =>
  Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) &&
  Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

const labelInput = (resolution, cx, cy) => ({
  cx,
  cy,
  rect: resolution.mapRect,
  panelBounds: resolution.labelRect,
  keepOut: resolution.interactiveGapRect,
});

/* -------------------------------------------------------------------------- *
 * 场景 1-6：平台 × 描述等级
 * -------------------------------------------------------------------------- */

for (const platform of PLATFORMS) {
  for (const [tier, chars, bottom] of TIER_CASES) {
    test(`场景：${platform} + ${tier} 描述（${chars} 字符）→ 底部预留 ${bottom}px`, () => {
      const resolution = resolveSafeArea(config, {
        platform,
        description: 'x'.repeat(chars),
      });

      assert.equal(resolution.platform, platform);
      assert.equal(resolution.descriptionTier, tier);
      assert.equal(resolution.descriptionChars, chars);
      assert.equal(resolution.margins.bottom, bottom);
      // 核心安全区跟着底部预留收缩。
      assert.equal(resolution.coreRect.y1, resolution.canvas.height - bottom);
      assert.equal(resolution.coreRect.y0, resolution.margins.top);
      assert.equal(resolution.coreRect.x0, resolution.margins.left);
      // 右侧互动栏禁入区贴着画布右边缘时，核心安全区右边界要收到「禁入区左边界
      // - contentGapPx」，否则贴着安全区右边放下内容会正好落进那段间距里；
      // 禁入区不贴右边缘时才等于「画布宽度 - 右边距」。
      const keepOutHugsRight =
        resolution.interactiveRect !== null &&
        resolution.interactiveRect.x1 >= resolution.canvas.width;
      assert.equal(
        resolution.coreRect.x1,
        keepOutHugsRight
          ? resolution.interactiveRect.x0 - resolution.contentGapPx
          : resolution.canvas.width - resolution.margins.right,
      );
      // 不论走哪条分支，核心安全区都不能与禁入区（含 contentGapPx 间距）相交。
      if (resolution.interactiveGapRect) {
        assert.equal(
          overlaps(resolution.coreRect, resolution.interactiveGapRect),
          false,
          '核心安全区不应与禁入区（含间距）相交',
        );
      }
      // 标签安全区 = 核心安全区再内缩 contentGapPx。
      assert.equal(resolution.labelRect.x0, resolution.coreRect.x0 + resolution.contentGapPx);
      assert.equal(resolution.labelRect.y1, resolution.coreRect.y1 - resolution.contentGapPx);
      // 地图底图横向铺到画布边缘附近；纵向按 mapBleed 吃进上/下预留带，
      // 但永远不会超出画布。
      assert.ok(resolution.mapRect.x0 < resolution.margins.left);
      const bleed = config.platforms[platform].mapBleed;
      assert.equal(resolution.mapRect.y0, Math.max(0, resolution.margins.top - bleed.top));
      assert.equal(
        resolution.mapRect.y1,
        Math.min(resolution.canvas.height, resolution.canvas.height - bottom + bleed.bottom),
      );
      // 底图出血只影响底图：核心区 / 标签区 / 预留带都不跟着动。
      assert.ok(resolution.mapRect.y0 < resolution.coreRect.y0);
      assert.ok(resolution.mapRect.y1 > resolution.coreRect.y1);
      // 参数来源标注清楚，且没有把估值当成官方规范。
      assert.equal(resolution.provenance, 'initial-estimate');
      assert.equal(resolution.version, config.version);
      assert.deepEqual(resolution.warnings, []);
    });
  }
}

test('场景：描述等级边界可配置，且 short/medium/long 使用各自的底部预留', () => {
  const tiers = normalizeSafeAreaConfig(config).config.tiers;
  assert.equal(selectDescriptionTier('', tiers).id, 'short');
  assert.equal(selectDescriptionTier('a'.repeat(80), tiers).id, 'short');
  assert.equal(selectDescriptionTier('a'.repeat(81), tiers).id, 'medium');
  assert.equal(selectDescriptionTier('a'.repeat(200), tiers).id, 'medium');
  assert.equal(selectDescriptionTier('a'.repeat(201), tiers).id, 'long');
  assert.equal(selectDescriptionTier('a'.repeat(20000), tiers).id, 'long');

  // 边界值改了，选择结果跟着改 —— 说明边界来自配置，不是写死的。
  const custom = {
    ...config,
    descriptionTiers: [
      {tier: 'short', maxChars: 10, bottomPx: 400},
      {tier: 'medium', maxChars: 30, bottomPx: 500},
      {tier: 'long', maxChars: null, bottomPx: 700},
    ],
    // 清掉平台级的按等级覆盖，让全局等级配置直接生效。
    platforms: {
      tiktok: {...config.platforms.tiktok, bottomByTier: {}},
      douyin: {...config.platforms.douyin, bottomByTier: {}},
    },
  };
  const short = resolveSafeArea(custom, {description: 'a'.repeat(9)});
  const medium = resolveSafeArea(custom, {description: 'a'.repeat(11)});
  const long = resolveSafeArea(custom, {description: 'a'.repeat(31)});
  assert.equal(short.descriptionTier, 'short');
  assert.equal(short.margins.bottom, 400);
  assert.equal(short.bottomSource, 'tier');
  assert.equal(medium.descriptionTier, 'medium');
  assert.equal(medium.margins.bottom, 500);
  assert.equal(long.descriptionTier, 'long');
  assert.equal(long.margins.bottom, 700);

  // 平台自己的 bottomByTier 优先于全局等级底距（平台可以单独调某一档）。
  const overridden = resolveSafeArea(config, {platform: 'douyin', description: 'a'.repeat(9)});
  assert.equal(overridden.margins.bottom, config.platforms.douyin.bottomByTier.short);
  assert.equal(overridden.bottomSource, 'platform');
});

/* -------------------------------------------------------------------------- *
 * 场景 7-9：标签靠边 / 贴底
 * -------------------------------------------------------------------------- */

test('场景：排名标签落在画面最左侧时，面板仍完整留在安全区内', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  const placement = placeLabel(labelInput(resolution, 6, 900));

  assert.equal(placement.conflict, null);
  assert.ok(labelFitsBounds(placement, resolution.labelRect));
  assert.ok(placement.panelRect.x0 >= resolution.labelRect.x0);
  assert.ok(placement.panelRect.x1 <= resolution.labelRect.x1);
  assert.equal(placement.flipped, false);
});

test('场景：排名标签落在画面最右侧时，面板被推离右侧互动栏禁入区', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  const placement = placeLabel(labelInput(resolution, resolution.canvas.width - 8, 1000));

  assert.equal(placement.conflict, null, placement.conflict?.detail);
  assert.ok(labelFitsBounds(placement, resolution.labelRect));
  assert.ok(
    !overlaps(placement.panelRect, resolution.interactiveGapRect),
    `面板 ${JSON.stringify(placement.panelRect)} 压住了禁入区 ${JSON.stringify(resolution.interactiveGapRect)}`,
  );
  // 面板被推到了禁入区左边。
  assert.ok(placement.panelRect.x1 <= resolution.interactiveGapRect.x0);
});

test('场景：排名标签落在底部安全区边缘时，面板不会压进底部预留', () => {
  const resolution = resolveSafeArea(config, {platform: 'douyin', description: 'x'.repeat(260)});
  const bottomEdge = resolution.coreRect.y1;
  const placement = placeLabel(labelInput(resolution, 540, bottomEdge + 200));

  assert.equal(placement.conflict, null);
  assert.ok(labelFitsBounds(placement, resolution.labelRect));
  assert.ok(placement.panelRect.y1 <= resolution.labelRect.y1);
  assert.ok(
    placement.panelRect.y1 <= resolution.canvas.height - resolution.margins.bottom,
    '标签不得进入底部预留带（抖音描述 + 系统导航栏）',
  );
});

/* -------------------------------------------------------------------------- *
 * 场景 10：标签重叠
 * -------------------------------------------------------------------------- */

test('场景：两个排名标签重叠时能报出可定位的冲突', () => {
  const resolution = resolveSafeArea(config, {description: 'x'.repeat(20)});
  const a = {id: 'label:TH-10', component: 'ThailandMap/placeLabel', kind: 'panel', rect: {x0: 100, y0: 500, x1: 385, y1: 605}};
  const b = {id: 'label:TH-11', component: 'ThailandMap/placeLabel', kind: 'panel', rect: {x0: 300, y0: 560, x1: 585, y1: 665}};
  const issue = checkOverlap(a, b, resolution.contentGapPx);

  assert.ok(issue);
  assert.equal(issue.code, 'LABEL_OVERLAP');
  assert.equal(issue.elementId, 'label:TH-10');
  assert.ok(issue.detail.includes('label:TH-11'));
  assert.ok(issue.overflowPx > 0);

  // 分开的标签不该误报。
  assert.equal(
    checkOverlap(a, {...b, rect: {x0: 700, y0: 900, x1: 985, y1: 1005}}, resolution.contentGapPx),
    null,
  );

  // 两个距离很近的府（相邻锚点）在完整审计里也会被报出来。
  const audit = auditSafeAreaLayout({
    resolution,
    elements: [a, b],
    labelGapPx: resolution.contentGapPx,
  });
  assert.ok(audit.overlaps.length >= 1);
  assert.ok(audit.violatingIds.includes('label:TH-10'));
  assert.ok(audit.lines.some((line) => line.includes('重叠')));
});

/* -------------------------------------------------------------------------- *
 * 场景 11：泰语 / 中文 / 英文 / 表情 / 换行混合描述
 * -------------------------------------------------------------------------- */

test('场景：泰语、中文、英文、表情符号与换行混合的描述按字符数选档', () => {
  const mixed =
    '🇹🇭 Thailand Province Ranking อันดับ 1 กรุงเทพมหานคร\n' +
    '#泰国府级排名 #อันดับจังหวัด #ThailandRanking 🎬✨\n'.repeat(3);
  const chars = Array.from(mixed).length;

  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: mixed});
  assert.equal(resolution.descriptionChars, chars);
  assert.equal(resolution.descriptionTier, chars <= 80 ? 'short' : chars <= 200 ? 'medium' : 'long');
  // 混合文本不会产生 NaN 矩形或额外告警。
  assert.deepEqual(resolution.warnings, []);
  assert.ok(Number.isFinite(resolution.coreRect.y1));

  // 同样的文案在抖音上走的是抖音那套配置（两套独立）。
  const douyin = resolveSafeArea(config, {platform: 'douyin', description: mixed});
  assert.equal(douyin.descriptionTier, resolution.descriptionTier);
  assert.equal(douyin.platform, 'douyin');
});

/* -------------------------------------------------------------------------- *
 * 场景 12：空描述 / 超长描述 / 异常配置
 * -------------------------------------------------------------------------- */

test('场景：描述缺失时回退到 short 档并给出警告', () => {
  const empty = resolveSafeArea(config, {platform: 'tiktok', description: ''});
  assert.equal(empty.descriptionTier, 'short');
  assert.equal(empty.descriptionChars, 0);
  assert.equal(empty.margins.bottom, 480);
  assert.ok(empty.warnings.some((warning) => warning.includes('发布描述缺失')));

  const missing = resolveSafeArea(config, {});
  assert.equal(missing.descriptionTier, 'short');
  assert.ok(missing.warnings.some((warning) => warning.includes('发布描述缺失')));
  // 平台也没给 → 用 defaultPlatform。
  assert.equal(missing.platform, config.defaultPlatform);
});

test('场景：超长描述落到无上限档，且不会把画布吃光', () => {
  const huge = resolveSafeArea(config, {
    platform: 'douyin',
    description: 'อันดับ'.repeat(4000),
  });
  assert.equal(huge.descriptionTier, 'long');
  assert.equal(huge.margins.bottom, 600);
  assert.ok(huge.coreRect.y1 > 0 && huge.coreRect.y1 < huge.canvas.height);
  assert.ok(huge.labelRect.y1 > huge.labelRect.y0);
});

test('场景：异常配置回退到安全默认值并逐条告警', () => {
  const broken = {
    version: 123,
    canvas: {width: -10, height: 'tall'},
    defaultPlatform: 'weibo',
    contentGapPx: -5,
    descriptionTiers: 'oops',
    platforms: {
      tiktok: {
        margins: {top: -100, bottom: 'lots', left: null, right: 180},
        bottomByTier: {short: -1},
        interactiveKeepOut: {x: 900, y: 650, width: 0, height: 930},
      },
      // douyin 整块缺失 → 用内置默认值补齐，但不会串到 tiktok。
    },
  };

  const {config: normalized, warnings} = normalizeSafeAreaConfig(broken);
  assert.ok(warnings.length >= 4, `至少 4 条告警，实际 ${warnings.length}：${warnings.join(' / ')}`);
  assert.equal(normalized.canvas.width, DEFAULT_SAFE_AREA_CONFIG.canvas.width);
  assert.equal(normalized.defaultPlatform, 'tiktok');
  assert.equal(normalized.contentGapPx, DEFAULT_SAFE_AREA_CONFIG.contentGapPx);
  assert.deepEqual(
    normalized.tiers.map((tier) => tier.id),
    ['short', 'medium', 'long'],
  );

  const resolution = resolveSafeArea(broken, {platform: 'weibo', description: 'x'.repeat(10)});
  assert.equal(resolution.platform, 'tiktok');
  assert.ok(resolution.warnings.some((warning) => warning.includes('平台取值非法')));
  // 负的 top 回退成默认 240，而不是把安全区压成负数。
  assert.equal(resolution.margins.top, DEFAULT_SAFE_AREA_CONFIG.platforms.tiktok.margins.top);
  assert.ok(resolution.coreRect.y1 > resolution.coreRect.y0);
  assert.ok(resolution.labelRect.x1 > resolution.labelRect.x0);
});

test('场景：预留大到把安全区压空时收敛并告警', () => {
  const greedy = {
    ...config,
    platforms: {
      ...config.platforms,
      tiktok: {
        ...config.platforms.tiktok,
        margins: {top: 1500, bottom: 1500, left: 900, right: 900},
      },
    },
  };
  const resolution = resolveSafeArea(greedy, {platform: 'tiktok', description: 'x'.repeat(10)});
  assert.ok(resolution.warnings.some((warning) => warning.includes('超过画布')));
  assert.ok(resolution.coreRect.x1 > resolution.coreRect.x0);
  assert.ok(resolution.coreRect.y1 > resolution.coreRect.y0);
  assert.ok(resolution.labelRect.x1 > resolution.labelRect.x0);
});

/* -------------------------------------------------------------------------- *
 * 检测函数本身
 * -------------------------------------------------------------------------- */

test('越界检测给出方向、像素与所属组件', () => {
  const resolution = resolveSafeArea(config, {description: 'x'.repeat(10)});
  const inside = {
    id: 'label:TH-10',
    component: 'ThailandMap/placeLabel',
    kind: 'panel',
    rect: {x0: 200, y0: 400, x1: 400, y1: 500},
  };
  assert.equal(checkBounds(inside, resolution.coreRect), null);

  const outside = {...inside, rect: {x0: 10, y0: 100, x1: 120, y1: 130}};
  const issue = checkBounds(outside, resolution.coreRect);
  assert.ok(issue);
  assert.equal(issue.code, 'OUT_OF_CORE');
  assert.deepEqual(issue.directions.sort(), ['left', 'top']);
  assert.equal(issue.overflowPx, Math.max(72 - 10, 240 - 100));
  assert.equal(issue.elementId, 'label:TH-10');
  assert.equal(issue.component, 'ThailandMap/placeLabel');
  assert.ok(issue.detail.includes('TH-10'));
});

test('右侧互动栏禁入区检测只约束重要内容，不约束地图底图', () => {
  const resolution = resolveSafeArea(config, {description: 'x'.repeat(10)});
  const conflict = {
    id: 'label:TH-10',
    component: 'ThailandMap/placeLabel',
    kind: 'panel',
    rect: {x0: 950, y0: 700, x1: 1000, y1: 800},
  };
  const issue = checkKeepOut(conflict, resolution.interactiveGapRect);
  assert.ok(issue);
  assert.equal(issue.code, 'IN_KEEP_OUT');
  assert.equal(issue.severity, 'error');
  assert.ok(issue.detail.includes('互动栏'));

  // 底图允许延伸到画布边缘，所以带 allowKeepOut 的元素不报。
  assert.equal(
    checkKeepOut({...conflict, allowKeepOut: true, kind: 'map'}, resolution.interactiveGapRect),
    null,
  );
  // 没有禁入区的平台配置 → 不报。
  assert.equal(checkKeepOut(conflict, null), null);
});

test('统一审计同时报告越界、禁入与标签重叠', () => {
  const resolution = resolveSafeArea(config, {description: 'x'.repeat(120)});
  const audit = auditSafeAreaLayout({
    resolution,
    elements: [
      {id: 'header:title', component: 'video/header', kind: 'text', rect: resolution.coreRect},
      {
        id: 'label:TH-10',
        component: 'ThailandMap/placeLabel',
        kind: 'panel',
        rect: {x0: 940, y0: 700, x1: 1000, y1: 800},
      },
      {
        id: 'label:TH-11',
        component: 'ThailandMap/placeLabel',
        kind: 'panel',
        rect: {x0: 20, y0: 10, x1: 120, y1: 60},
      },
    ],
    labelGapPx: resolution.contentGapPx,
  });

  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some((issue) => issue.code === 'IN_KEEP_OUT'));
  assert.ok(audit.issues.some((issue) => issue.code === 'OUT_OF_LABEL_RECT'));
  assert.ok(audit.violatingIds.includes('label:TH-11'));
  assert.ok(audit.lines.length >= 2);
  // 诊断可打印、可定位。
  assert.ok(audit.lines.every((line) => /[\u4e00-\u9fa5]/.test(line)));
});

test('describeSafeArea 输出平台、等级、四边预留与矩形坐标', () => {
  const resolution = resolveSafeArea(config, {platform: 'douyin', description: 'x'.repeat(150)});
  const lines = describeSafeArea(resolution).join('\n');
  assert.ok(lines.includes('抖音'));
  assert.ok(lines.includes('medium'));
  assert.ok(lines.includes('初始估值'));
  assert.ok(lines.includes('核心安全区'));
  assert.ok(lines.includes('标签安全区'));
  assert.ok(lines.includes('禁入区'));
  assert.ok(lines.includes('配置版本'));
});

/* -------------------------------------------------------------------------- *
 * 平台隔离
 * -------------------------------------------------------------------------- */

test('平台配置互相隔离：改抖音不影响 TikTok，反之亦然', () => {
  const custom = {
    ...config,
    platforms: {
      ...config.platforms,
      douyin: {
        ...config.platforms.douyin,
        margins: {top: 320, bottom: 700, left: 96, right: 240},
        bottomByTier: {short: 700, medium: 760, long: 820},
        interactiveKeepOut: {x: 840, y: 520, width: 200, height: 1100},
      },
    },
  };

  const tiktok = resolveSafeArea(custom, {platform: 'tiktok', description: 'x'.repeat(10)});
  const douyin = resolveSafeArea(custom, {platform: 'douyin', description: 'x'.repeat(10)});

  assert.deepEqual(tiktok.margins, config.platforms.tiktok.margins);
  assert.deepEqual(douyin.margins, {top: 320, bottom: 700, left: 96, right: 240});
  assert.equal(tiktok.interactiveRect.x0, 900);
  assert.equal(douyin.interactiveRect.x0, 840);
  // 两个平台各自独立解析，不会共享缓存出来的矩形对象。
  assert.notEqual(tiktok.coreRect, douyin.coreRect);
});

/* -------------------------------------------------------------------------- *
 * 接入取景 / 渲染
 * -------------------------------------------------------------------------- */

test('安全区接入取景：地图底图可用区与标签安全区都按平台配置收敛', () => {
  const short = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(10)});
  const long = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(300)});

  const viewOf = (resolution) =>
    resolveViewport(geojson, EAST, {}, MAP_STAGE, {
      mapRect: resolution.mapRect,
      labelRect: resolution.labelRect,
      keepOutRect: resolution.interactiveGapRect,
    });

  const viewShort = viewOf(short);
  const viewLong = viewOf(long);

  assert.equal(viewShort.mapRect.y1, Math.min(1920, 1920 - short.margins.bottom + config.platforms.tiktok.mapBleed.bottom));
  assert.equal(viewShort.mapRect.y0, Math.max(0, short.margins.top - config.platforms.tiktok.mapBleed.top));
  assert.equal(viewShort.labelRect.x1, short.labelRect.x1);
  assert.equal(viewShort.keepOutRect.x0, short.interactiveGapRect.x0);
  // 描述越长，底部预留越大 → 地图视野越靠上（视野随等级调整）。
  assert.ok(viewLong.rect.y1 < viewShort.rect.y1);
  // 但排名区域仍然全部在画面内：安全区不会让内容消失。
  assert.equal(viewShort.coverage, 1);
  assert.deepEqual(viewShort.droppedIds, []);
  assert.equal(viewLong.coverage, 1);
});

test('mapBleed：底图纵向出血把地图撑大、收窄两侧留白，且不影响标题/标签安全区', () => {
  const withBleed = resolveSafeArea(config, {platform: 'douyin', description: 'x'.repeat(10)});

  // 把出血设为 0 → 回到"底图完全不进预留带"的保守布局。
  const noBleedConfig = {
    ...config,
    version: 'bleed-0',
    platforms: {
      ...config.platforms,
      douyin: {...config.platforms.douyin, mapBleed: {top: 0, bottom: 0}},
    },
  };
  const noBleed = resolveSafeArea(noBleedConfig, {platform: 'douyin', description: 'x'.repeat(10)});

  // 出血只动 mapRect：核心区 / 标签区 / 预留带保持不变。
  assert.equal(noBleed.coreRect.y0, withBleed.coreRect.y0);
  assert.equal(noBleed.coreRect.y1, withBleed.coreRect.y1);
  assert.deepEqual(noBleed.labelRect, withBleed.labelRect);
  assert.deepEqual(noBleed.margins, withBleed.margins);
  assert.equal(noBleed.mapRect.y0, noBleed.margins.top);
  assert.equal(noBleed.mapRect.y1, 1920 - noBleed.margins.bottom);
  assert.ok(withBleed.mapRect.y0 < noBleed.mapRect.y0);
  assert.ok(withBleed.mapRect.y1 > noBleed.mapRect.y1);

  // 底图可用的纵向空间变大 → 取景比例尺变大（地图被撑大）。
  // 注意：只有"高度先顶满"的数据（南北跨度大）才会受益；EAST 那种紧凑的
  // 东部集群是宽度先顶满，出血对它没有影响 —— 所以这里用南北跨度大的组合。
  const SPREAD = ['TH-10', 'TH-20', 'TH-50', 'TH-83', 'TH-21'];
  const viewOf = (resolution, ids) =>
    resolveViewport(geojson, ids ?? EAST, {}, MAP_STAGE, {
      mapRect: resolution.mapRect,
      labelRect: resolution.labelRect,
      keepOutRect: resolution.interactiveGapRect,
    });
  const viewWith = viewOf(withBleed, SPREAD);
  const viewWithout = viewOf(noBleed, SPREAD);
  assert.ok(viewWith.scale > viewWithout.scale, '出血后底图比例尺应更大');
  // 泰国形状瘦高、高度先顶满：比例尺变大后两侧留白收窄。
  const widthOf = (viewport) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const diagnostic of viewport.diagnostics) {
      if (!viewport.keptIds.includes(diagnostic.provinceId)) continue;
      const [cx] = diagnostic.center;
      const half = diagnostic.sizePx[0] / 2;
      if (!Number.isFinite(cx)) continue;
      x0 = Math.min(x0, cx - half);
      x1 = Math.max(x1, cx + half);
    }
    return x1 - x0;
  };
  assert.ok(widthOf(viewWith) > widthOf(viewWithout), '出血后底图应更宽');
  // 而宽度先顶满的数据（EAST）比例尺不受出血影响 —— 出血不是无脑放大。
  assert.equal(viewOf(withBleed).scale, viewOf(noBleed).scale);

  // 非法出血值回退默认并逐条告警，不产生坏布局。
  const bad = normalizeSafeAreaConfig({
    ...config,
    platforms: {
      ...config.platforms,
      douyin: {...config.platforms.douyin, mapBleed: {top: -5, bottom: 'x'}},
    },
  });
  assert.equal(bad.config.platforms.douyin.mapBleed.top, config.platforms.douyin.mapBleed.top);
  assert.equal(bad.config.platforms.douyin.mapBleed.bottom, config.platforms.douyin.mapBleed.bottom);
  assert.ok(bad.warnings.some((line) => line.includes('mapBleed.top')));
  assert.ok(bad.warnings.some((line) => line.includes('mapBleed.bottom')));
});

test('不传安全区时取景行为与原来一致（向后兼容）', () => {
  const legacy = resolveViewport(geojson, EAST, {}, MAP_STAGE);

  // 没有安全区时，viewport 不带那两个字段 —— 旧调用方拿到的结构没变。
  assert.equal(legacy.mapRect, undefined);
  assert.equal(legacy.keepOutRect, undefined);

  // 取景矩形仍然取自内置的标题/页脚带（再叠加 preset padding），
  // 也就是这次改动**没有**悄悄改变默认布局。
  const span = Math.min(
    MAP_STAGE.width - MAP_SAFE_INSET.left - MAP_SAFE_INSET.right,
    MAP_STAGE.height - MAP_SAFE_INSET.top - MAP_SAFE_INSET.bottom,
  );
  const extra = Math.round(0.06 * span); // balanced preset 的默认 padding
  assert.equal(legacy.rect.x0, MAP_SAFE_INSET.left + extra);
  assert.equal(legacy.rect.y1, MAP_STAGE.height - MAP_SAFE_INSET.bottom - extra);
  assert.equal(legacy.labelRect.x0, 0);
  assert.equal(legacy.labelRect.y0, MAP_OVERLAY_BANDS.top);
  assert.equal(legacy.labelRect.y1, MAP_STAGE.height - MAP_OVERLAY_BANDS.bottom);
});

test('正式渲染的 props 不含调试遮罩开关，遮罩只在显式开启时渲染', () => {
  assert.equal(isDebugOverlayEnabled({}), false);
  assert.equal(isDebugOverlayEnabled({title: 'x', ranking: []}), false);
  assert.equal(isDebugOverlayEnabled({debugSafeArea: false}), false);
  assert.equal(isDebugOverlayEnabled({debugSafeArea: 'yes'}), false);
  assert.equal(isDebugOverlayEnabled({debugSafeArea: true}), true);

  // 生成路径写出的 render props 里必须没有这个字段。
  const serverSource = fs.readFileSync(
    path.join(root, 'scripts', 'web-server.mjs'),
    'utf8',
  );
  const start = serverSource.indexOf('const renderProps = {');
  const end = serverSource.indexOf('renderPropsPath,', start);
  assert.ok(start > 0 && end > start, '找不到 renderProps 代码块');
  const block = serverSource.slice(start, end);
  assert.ok(!/debugSafeArea\s*:/.test(block), 'renderProps 里不应出现 debugSafeArea');
  // 同时确认安全区确实接进了渲染（否则上面那条断言会变成空谈）。
  assert.ok(/safeArea:/.test(block));
  assert.ok(/platform:/.test(block));
});

/* -------------------------------------------------------------------------- *
 * 配置加载
 * -------------------------------------------------------------------------- */

test('配置文件按 TTS 同一套约定加载，坏配置只降级不改行为', () => {
  const loaded = loadSafeAreaConfig(root);
  assert.equal(loaded.warning, null);
  assert.ok(loaded.configPath.endsWith('safe-area.config.json'));
  assert.equal(loaded.config.version, config.version);
  assert.ok(loaded.config.platforms.tiktok && loaded.config.platforms.douyin);

  const previous = process.env.SAFE_AREA_CONFIG_PATH;
  const scratchDir = path.join(root, 'out', '__safe-area-test');
  fs.mkdirSync(scratchDir, {recursive: true});

  try {
    // 覆盖路径不存在 → 回退到 src/config（与 TTS 加载器同一套回退逻辑）。
    process.env.SAFE_AREA_CONFIG_PATH = 'config/does-not-exist.json';
    const fallback = loadSafeAreaConfig(root);
    assert.equal(fallback.warning, null);
    assert.ok(fallback.configPath.endsWith('safe-area.config.json'));
    assert.equal(fallback.config.version, config.version);

    // 覆盖路径存在但内容坏掉 → 告警 + null 配置，调用方回退到内置默认值。
    const brokenPath = path.join(scratchDir, 'broken.json');
    fs.writeFileSync(brokenPath, '{ not json', 'utf8');
    process.env.SAFE_AREA_CONFIG_PATH = path.relative(root, brokenPath);
    const broken = loadSafeAreaConfig(root);
    assert.equal(broken.config, null);
    assert.ok(broken.warning.includes('无法解析'), broken.warning);

    // 完全没有配置文件 → 告警 + null 配置。
    const emptyRoot = path.join(scratchDir, 'no-config-root');
    fs.mkdirSync(emptyRoot, {recursive: true});
    const missing = loadSafeAreaConfig(emptyRoot);
    assert.equal(missing.config, null);
    assert.ok(missing.warning.includes('未找到安全区配置文件'));

    // 两种情况都必须能安全降级：仍然是可用的默认布局，不是"没有安全区"。
    const resolution = resolveSafeArea(missing.config, {platform: 'douyin'});
    assert.equal(resolution.platform, 'douyin');
    assert.equal(
      resolution.margins.bottom,
      DEFAULT_SAFE_AREA_CONFIG.platforms.douyin.margins.bottom,
    );
    assert.equal(resolution.provenance, 'initial-estimate');
    // 没给平台时用内置默认平台。
    assert.equal(
      resolveSafeArea(missing.config, {description: 'x'}).platform,
      DEFAULT_SAFE_AREA_CONFIG.defaultPlatform,
    );
  } finally {
    if (previous === undefined) delete process.env.SAFE_AREA_CONFIG_PATH;
    else process.env.SAFE_AREA_CONFIG_PATH = previous;
    fs.rmSync(scratchDir, {recursive: true, force: true});
  }
});

test('标签盒子尺寸与落位结果自洽', () => {
  const resolution = resolveSafeArea(config, {description: 'x'.repeat(10)});
  const placement = placeLabel(labelInput(resolution, 700, 800));
  assert.equal(
    Math.round(placement.panelRect.x1 - placement.panelRect.x0),
    LABEL_BOX.width,
  );
  assert.equal(
    Math.round(placement.panelRect.y1 - placement.panelRect.y0),
    LABEL_BOX.height,
  );
  // 引线起点贴在锚点旁边。
  assert.equal(Math.round(placement.anchor[0]), 700);
  assert.equal(Math.round(placement.anchor[1]), 800);
});
