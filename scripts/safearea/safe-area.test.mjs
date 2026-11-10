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
  SAFE_AREA_CONFIG_VERSION,
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
  EDGE_MARGIN,
  LABEL_BASELINE,
  LABEL_BOX,
  LABEL_CENTRE_RATIO,
  LABEL_FONT_SIZE,
  LABEL_NAME_CENTER_Y,
  MAX_MANUAL_OFFSET_PX,
  applyLabelOffset,
  labelFitsBounds,
  normalizeLabelOffset,
  normalizeLabelOffsetMap,
  placeLabel,
} from '../../src/video/layout/labelPlacement.ts';
import {theme} from '../../src/config/theme.ts';
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

/** 描述样例：字符数 -> 等级。TikTok 三档统一 150px，抖音仍按文案分档。 */
const TIER_CASES = [
  ['short', 20, {tiktok: 150, douyin: 480}],
  ['medium', 120, {tiktok: 150, douyin: 540}],
  ['long', 260, {tiktok: 150, douyin: 600}],
];

const PLATFORMS = ['tiktok', 'douyin'];

const overlaps = (a, b) =>
  Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) &&
  Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

/** 一个府在投影后的包围盒：中心 + 尺寸（默认 160x140，接近真实府尺度）。 */
const provinceAt = (cx, cy, width = 160, height = 140) => ({
  x0: cx - width / 2,
  y0: cy - height / 2,
  x1: cx + width / 2,
  y1: cy + height / 2,
});

const labelInput = (resolution, bounds) => ({
  bounds,
  panelBounds: resolution.labelRect,
  keepOut: resolution.interactiveGapRect,
});

/* -------------------------------------------------------------------------- *
 * 场景 1-6：平台 × 描述等级
 * -------------------------------------------------------------------------- */

for (const platform of PLATFORMS) {
  for (const [tier, chars, bottomByPlatform] of TIER_CASES) {
    const bottom = bottomByPlatform[platform];
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
      // 标签区已并入核心区（2026-11-07 简化）：不再有单独的「内框 / 标签安全带」。
      assert.deepEqual(resolution.labelRect, resolution.coreRect);
      // 取景矩形已合并进核心区（2026-11-07）：地图与文字共用一条边界，
      // 页面不再出现第二个框。
      assert.deepEqual(resolution.mapRect, resolution.coreRect);
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

test('场景：府贴着核心区最左侧时，文字块被收进核心区且不裁字', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  const placement = placeLabel(labelInput(resolution, provinceAt(6, 900)));

  assert.equal(placement.conflict, null, placement.conflict?.detail);
  assert.ok(labelFitsBounds(placement, resolution.labelRect));
  assert.ok(placement.panelRect.x0 >= resolution.labelRect.x0);
  assert.ok(placement.panelRect.x1 <= resolution.labelRect.x1);
  // 靠边时整块贴住核心区左沿（留出 EDGE_MARGIN），不是半个字出画。
  assert.equal(Math.round(placement.panelRect.x0), resolution.labelRect.x0 + EDGE_MARGIN);
  // 横向被收进来，纵向仍严格压住府的中心（府名那一行的正中）。
  assert.ok(Math.abs(placement.panelRect.y0 + LABEL_NAME_CENTER_Y - 900) < 0.5);
});

test('场景：文字块会压到右侧互动栏时，整体左移让开禁入区', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  // 显式给一个互动栏禁入区，不依赖平台右边距的当前默认值 —— 这里测的是
  // 「让开」这条规则本身，而不是某个平台的具体宽度。
  const keepOut = {x0: 900, y0: 650, x1: 1080, y1: 1580};
  const placement = placeLabel({
    bounds: provinceAt(resolution.canvas.width - 8, 1000),
    panelBounds: resolution.labelRect,
    keepOut,
  });

  assert.equal(placement.conflict, null, placement.conflict?.detail);
  assert.ok(labelFitsBounds(placement, resolution.labelRect));
  assert.ok(
    !overlaps(placement.panelRect, keepOut),
    `文字块 ${JSON.stringify(placement.panelRect)} 压住了禁入区 ${JSON.stringify(keepOut)}`,
  );
  // 文字块被推到禁入区左边，并如实记录偏移量。
  assert.ok(placement.panelRect.x1 <= keepOut.x0);
  assert.ok(placement.keepOutShiftPx > 0, '应记录为了让开互动栏而左移的像素');
});

test('场景：府贴着核心区底部时，文字仍压在府身上、不压进底部预留', () => {
  const resolution = resolveSafeArea(config, {platform: 'douyin', description: 'x'.repeat(260)});
  const bottomEdge = resolution.coreRect.y1;
  const province = provinceAt(540, bottomEdge - 70);
  const placement = placeLabel(labelInput(resolution, province));

  assert.equal(placement.conflict, null, placement.conflict?.detail);
  assert.ok(labelFitsBounds(placement, resolution.labelRect));
  assert.ok(placement.panelRect.y0 >= province.y0, '文字块完整落在府顶之下，没有飘到府外');
  assert.ok(placement.panelRect.y1 <= resolution.labelRect.y1);
  assert.ok(
    placement.panelRect.y1 <= resolution.canvas.height - resolution.margins.bottom,
    '标签不得进入底部预留带（抖音描述 + 系统导航栏）',
  );
});

/* -------------------------------------------------------------------------- *
 * 落位规则：水平中心对齐 + 第二行府名的中心 = 府的中心
 * -------------------------------------------------------------------------- */

test('落位：水平中心 = 府的中心，纵向第二行府名的中心也压在府中心上', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  const province = provinceAt(540, 1000, 300, 320);
  const placement = placeLabel(labelInput(resolution, province));

  const blockCenterX = (placement.panelRect.x0 + placement.panelRect.x1) / 2;
  assert.equal(Math.round(blockCenterX), Math.round((province.x0 + province.x1) / 2));
  assert.equal(placement.keepOutShiftPx, 0, '画面中央的府不应被推离中心');

  // 唯一的纵向铁律：府名那一行的视觉中心 = 府中心。
  const provinceCentreY = (province.y0 + province.y1) / 2;
  const nameCentreY = placement.panelRect.y0 + LABEL_NAME_CENTER_Y;
  assert.ok(
    Math.abs(nameCentreY - provinceCentreY) < 0.5,
    `府名中心 ${nameCentreY} 应压住府中心 ${provinceCentreY}`,
  );
});

test('落位：府比文字块还矮时，块对称地跨在府身上，不会整体掉到府下方', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  // 曼谷的真实尺度：83 x 56px，比 102px 高的三行文字还矮 —— 旧规则会在这种
  // 情况下把整块往下推，看起来就像数据掉进海面。
  const province = provinceAt(632, 955, 83, 56);
  const placement = placeLabel(labelInput(resolution, province));

  assert.equal(placement.conflict, null, placement.conflict?.detail);
  const centreY = 955;
  const nameCentreY = placement.panelRect.y0 + LABEL_NAME_CENTER_Y;
  assert.ok(Math.abs(nameCentreY - centreY) < 0.5, '府名中心仍严格压在府中心上');
  // 装不下就上下对称溢出，而不是单边往下溢。
  const above = centreY - placement.panelRect.y0;
  const below = placement.panelRect.y1 - centreY;
  assert.ok(Math.abs(above - below) < LABEL_BOX.height, `溢出应为对称（上 ${above} / 下 ${below}）`);
  assert.ok(placement.panelRect.y1 - province.y1 <= LABEL_BOX.height / 2 + 1, '块底不会甩到府下方一大截');
});

test('落位：府贴着核心区上沿时，文字块收进核心区而不是出画', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  // 府的上边几乎贴着核心区顶边，府中心 − 55 已经落到核心区之外。
  const province = {x0: 460, y0: resolution.coreRect.y0 + 10, x1: 620, y1: resolution.coreRect.y0 + 80};
  const placement = placeLabel(labelInput(resolution, province));

  assert.ok(labelFitsBounds(placement, resolution.labelRect));
  assert.equal(
    Math.round(placement.panelRect.y0),
    Math.round(resolution.labelRect.y0),
    '贴顶时整块被收进核心区上沿',
  );
});

test('落位：读数常驻后相邻小府撞车，后来的标签让位且互不重叠', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  // 模拟春武里 / 罗勇这种相邻小府：默认位几乎重叠。
  const first = provinceAt(760, 1020, 150, 120);
  const second = provinceAt(880, 1060, 150, 120);
  const firstPlacement = placeLabel(labelInput(resolution, first));
  const secondPlacement = placeLabel({
    ...labelInput(resolution, second),
    occupied: [firstPlacement.panelRect],
  });

  assert.ok(
    !overlaps(secondPlacement.panelRect, firstPlacement.panelRect),
    `第二个读数 ${JSON.stringify(secondPlacement.panelRect)} 仍压在第一个 ${JSON.stringify(firstPlacement.panelRect)} 上`,
  );
  // 让位有界：上下各一个文字块高度以内，不再无限往下平移。
  const anchoredY = (second.y0 + second.y1) / 2 - LABEL_NAME_CENTER_Y;
  const shift = Math.abs(secondPlacement.panelRect.y0 - anchoredY);
  assert.ok(shift <= LABEL_BOX.height + 0.5, `让位位移 ${shift}px 超出上限 ${LABEL_BOX.height}px`);
  // 让位后仍然贴着第二个府，没有甩到画面另一头。
  assert.ok(secondPlacement.panelRect.y0 >= second.y0);
  assert.ok(secondPlacement.panelRect.y0 <= second.y1 + LABEL_BOX.height);
});

test('落位：让不开时保持严格对齐（对齐优先于避让），残余重叠交给审计', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  // 上下左右都被占满：任何位移都撞车，此时必须回到「府名中心 = 府中心」。
  const province = provinceAt(540, 1000, 200, 160);
  const occupied = [
    {x0: 300, y0: 700, x1: 780, y1: 900},
    {x0: 300, y0: 901, x1: 780, y1: 1100},
    {x0: 300, y0: 1101, x1: 780, y1: 1300},
  ];
  const placement = placeLabel({...labelInput(resolution, province), occupied});

  const nameCentreY = placement.panelRect.y0 + LABEL_NAME_CENTER_Y;
  assert.ok(
    Math.abs(nameCentreY - 1000) <= LABEL_BOX.height,
    `对齐最多被让位推移一个文字块高度（实际 ${nameCentreY - 1000}px）`,
  );
});

test('落位：没有占用冲突时行为与旧规则一致（不受 occupied 空列表影响）', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  const province = provinceAt(540, 1000, 300, 320);
  const withOccupied = placeLabel({...labelInput(resolution, province), occupied: []});
  const without = placeLabel(labelInput(resolution, province));
  assert.deepEqual(withOccupied.panelRect, without.panelRect);
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
  assert.equal(empty.margins.bottom, 150);
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
  // 负的 top 回退成内置默认值，而不是把安全区压成负数。
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

  // 用当前生效的四边预留反推一个左上越界的元素，默认值再调也不会让断言失效。
  const outside = {
    ...inside,
    rect: {x0: resolution.margins.left - 10, y0: resolution.margins.top - 60, x1: 120, y1: 130},
  };
  const issue = checkBounds(outside, resolution.coreRect);
  assert.ok(issue);
  assert.equal(issue.code, 'OUT_OF_CORE');
  assert.deepEqual(issue.directions.sort(), ['left', 'top']);
  assert.equal(
    issue.overflowPx,
    Math.max(resolution.margins.left - outside.rect.x0, resolution.margins.top - outside.rect.y0),
  );
  assert.equal(issue.elementId, 'label:TH-10');
  assert.equal(issue.component, 'ThailandMap/placeLabel');
  assert.ok(issue.detail.includes('TH-10'));
});

test('右侧互动栏禁入区检测只约束重要内容，不约束地图底图', () => {
  const resolution = resolveSafeArea(config, {description: 'x'.repeat(10)});
  const gapRect = resolution.interactiveGapRect;
  // 贴着当前生效的禁入区放标签，右边距默认值再调也能命中。
  const conflictRect = {
    x0: gapRect.x0 + 1,
    y0: 700,
    x1: Math.min(gapRect.x1, gapRect.x0 + 20),
    y1: 800,
  };
  const conflict = {
    id: 'label:TH-10',
    component: 'ThailandMap/placeLabel',
    kind: 'panel',
    rect: conflictRect,
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
  const gapRect = resolution.interactiveGapRect;
  // 贴着当前生效的禁入区构造冲突，右边距默认值再调也能命中。
  const keepOutConflict = {
    x0: gapRect.x0 + 1,
    y0: 700,
    x1: Math.min(gapRect.x1, gapRect.x0 + 20),
    y1: 800,
  };
  const audit = auditSafeAreaLayout({
    resolution,
    elements: [
      {id: 'header:title', component: 'video/header', kind: 'text', rect: resolution.coreRect},
      {
        id: 'label:TH-10',
        component: 'ThailandMap/placeLabel',
        kind: 'panel',
        rect: keepOutConflict,
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
  assert.ok(lines.includes('顶部导航'));
  assert.ok(lines.includes('中间核心内容'));
  assert.ok(lines.includes('禁入区'));
  assert.ok(lines.includes('配置版本'));
  // 简化后日志里不再把「标签安全带」当成一个独立分区。
  assert.equal(lines.includes('标签安全区'), false);
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
  assert.equal(tiktok.interactiveRect.x0, tiktok.canvas.width - config.platforms.tiktok.margins.right);
  assert.equal(douyin.interactiveRect.x0, 840);
  // 两个平台各自独立解析，不会共享缓存出来的矩形对象。
  assert.notEqual(tiktok.coreRect, douyin.coreRect);
});

/* -------------------------------------------------------------------------- *
 * 接入取景 / 渲染
 * -------------------------------------------------------------------------- */

test('安全区接入取景：取景基准与标签边界都按平台配置收敛', () => {
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

  assert.deepEqual(viewShort.mapRect, short.coreRect);
  assert.equal(viewShort.labelRect.x1, short.labelRect.x1);
  assert.equal(viewShort.keepOutRect.x0, short.interactiveGapRect.x0);
  // TikTok 三档统一 150px：预留等高，视野不再随描述长度变化。
  assert.equal(short.margins.bottom, 150);
  assert.equal(long.margins.bottom, 150);
  assert.equal(viewLong.rect.y1, viewShort.rect.y1);
  // 但排名区域仍然全部在画面内：安全区不会让内容消失。
  assert.equal(viewShort.coverage, 1);
  assert.deepEqual(viewShort.droppedIds, []);
  assert.equal(viewLong.coverage, 1);
});

test('取景矩形恒等于核心区：不同平台与描述档位都只有一个矩形', () => {
  for (const platform of PLATFORMS) {
    for (const chars of [10, 120, 300]) {
      const resolution = resolveSafeArea(config, {platform, description: 'x'.repeat(chars)});
      assert.deepEqual(resolution.mapRect, resolution.coreRect);
      assert.deepEqual(resolution.labelRect, resolution.coreRect);
    }
  }
  // 取景端拿到的矩形就是核心区，文字与地图形状共用一条边界。
  const short = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(10)});
  const view = resolveViewport(geojson, EAST, {}, MAP_STAGE, {
    mapRect: short.mapRect,
    labelRect: short.labelRect,
    keepOutRect: short.interactiveGapRect,
  });
  assert.deepEqual(view.mapRect, short.coreRect);
  assert.equal(view.coverage, 1);
  assert.deepEqual(view.droppedIds, []);
});

test('真实排名数据：第 1 名曼谷的读数压在府中心上，不再掉到府下方的海面', () => {
  const rankings = JSON.parse(
    fs.readFileSync(path.join(root, 'public', 'data', 'rankings.json'), 'utf8'),
  );
  const resolution = resolveSafeArea(config, {platform: 'tiktok'});
  const view = resolveViewport(geojson, rankings.map((row) => row.provinceId), {}, MAP_STAGE, {
    mapRect: resolution.mapRect,
    labelRect: resolution.labelRect,
    keepOutRect: resolution.interactiveGapRect,
  });

  // 与渲染端同一套顺序：按名次落位（解说倒序 5→1，但布局顺序恒为 1→5）。
  const occupied = [];
  const placed = new Map();
  for (const diagnostic of [...view.diagnostics].sort((a, b) => a.order - b.order)) {
    const [[x0, y0], [x1, y1]] = diagnostic.bboxPx;
    const placement = placeLabel({
      bounds: {x0, y0, x1, y1},
      panelBounds: view.labelRect,
      keepOut: view.keepOutRect ?? null,
      occupied,
    });
    occupied.push(placement.panelRect);
    placed.set(diagnostic.provinceId, {placement, bbox: diagnostic.bboxPx});
  }

  // 曼谷只有 83x56px，比三行文字块（102px）还矮 —— 曾经整块被推到府中心以下。
  const bangkok = placed.get('TH-10');
  assert.ok(bangkok, '第 1 名曼谷必须参与落位');
  const centreY = (bangkok.bbox[0][1] + bangkok.bbox[1][1]) / 2;
  assert.ok(
    Math.abs(bangkok.placement.panelRect.y0 + LABEL_NAME_CENTER_Y - centreY) < 0.5,
    `曼谷的府名中心应压在府中心 ${centreY} 上`,
  );
  assert.ok(
    bangkok.placement.panelRect.y1 - bangkok.bbox[1][1] <= LABEL_BOX.height / 2,
    '曼谷的块底最多溢出半个块高，不再整块挂到府下方的海面',
  );

  // 每个府最多被让位推移一个文字块高度，读数不会飘到画面另一头。
  for (const [provinceId, {placement, bbox}] of placed) {
    const anchorY = (bbox[0][1] + bbox[1][1]) / 2 - LABEL_NAME_CENTER_Y;
    assert.ok(
      Math.abs(placement.panelRect.y0 - anchorY) <= LABEL_BOX.height + 0.5,
      `${provinceId} 的让位位移超出上限`,
    );
  }
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
  const province = provinceAt(700, 800);
  const placement = placeLabel(labelInput(resolution, province));
  assert.equal(
    Math.round(placement.panelRect.x1 - placement.panelRect.x0),
    LABEL_BOX.width,
  );
  assert.equal(
    Math.round(placement.panelRect.y1 - placement.panelRect.y0),
    LABEL_BOX.height,
  );
  // anchor 是府的中心，文字块的水平基准跟着它走。
  assert.equal(Math.round(placement.anchor[0]), 700);
  assert.equal(Math.round(placement.anchor[1]), 800);
});

/* -------------------------------------------------------------------------- *
 * 四分区模型：配置只写四个区，其余矩形都是派生量
 * -------------------------------------------------------------------------- */

test('配置只定义四个分区：互动栏横向范围由右边距推导，不再重复写 x/width', () => {
  for (const platform of PLATFORMS) {
    const raw = config.platforms[platform];
    assert.equal(raw.interactiveKeepOut.x, undefined);
    assert.equal(raw.interactiveKeepOut.width, undefined);

    const resolution = resolveSafeArea(config, {platform, description: 'x'.repeat(10)});
    assert.ok(resolution.interactiveRect);
    assert.equal(
      resolution.interactiveRect.x0,
      resolution.canvas.width - resolution.margins.right,
    );
    assert.equal(resolution.interactiveRect.x1, resolution.canvas.width);
    assert.equal(resolution.interactiveRect.y0, raw.interactiveKeepOut.y);
    assert.equal(
      resolution.interactiveRect.y1,
      raw.interactiveKeepOut.y + raw.interactiveKeepOut.height,
    );

    // 同一个事实只有一处来源：改右边距，互动栏跟着动。
    const wider = {
      ...config,
      platforms: {
        ...config.platforms,
        [platform]: { ...raw, margins: {...raw.margins, right: 240} },
      },
    };
    const moved = resolveSafeArea(wider, {platform, description: 'x'.repeat(10)});
    assert.equal(moved.interactiveRect.x0, moved.canvas.width - 240);
  }
});

test('随包配置、内置默认值与版本号一致：缺配置文件时不会悄悄换构图', () => {
  assert.equal(config.version, SAFE_AREA_CONFIG_VERSION);
  for (const platform of PLATFORMS) {
    assert.deepEqual(
      DEFAULT_SAFE_AREA_CONFIG.platforms[platform].margins,
      config.platforms[platform].margins,
    );
    assert.deepEqual(
      DEFAULT_SAFE_AREA_CONFIG.platforms[platform].bottomByTier,
      config.platforms[platform].bottomByTier,
    );
  }
  const fromFile = resolveSafeArea(config, {description: 'x'.repeat(10)});
  const fromDefaults = resolveSafeArea(null, {description: 'x'.repeat(10)});
  assert.deepEqual(fromDefaults.mapRect, fromFile.mapRect);
  assert.deepEqual(fromDefaults.coreRect, fromFile.coreRect);
  assert.deepEqual(fromDefaults.interactiveRect, fromFile.interactiveRect);
});

test('取景矩形统一为核心区：渲染端、配置说明与文档说法一致', () => {
  const video = fs.readFileSync(
    path.join(root, 'src', 'video', 'ThailandRankingVideo.tsx'),
    'utf8',
  );
  assert.ok(/fitRect:\s*design\.core/.test(video), '渲染端取景目标应是核心区');
  assert.ok(config.note.join('\n').includes('mapRect 恒等于 coreRect'));
  const doc = fs.readFileSync(path.join(root, 'SAFE_AREA.md'), 'utf8');
  assert.ok(doc.includes('fitRect（= coreRect）'));
  assert.equal(doc.includes('fitRect（= mapRect）'), false);
});

test('预览遮罩只画四分区：不再有独立的禁入区框', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const overlay = fs.readFileSync(
    path.join(root, 'src', 'video', 'components', 'SafeAreaOverlay.tsx'),
    'utf8',
  );
  assert.equal(/safe-keepout/.test(html), false);
  assert.equal(/interactiveRect/.test(overlay), false);
  assert.equal(/标签安全区|内框（标签安全带）/.test(html), false);
  assert.equal(/rect class="frame"|stroke-dasharray/.test(html), false, '不应再有取景虚线框');
  assert.ok(html.includes('顶部导航'));
  assert.ok(html.includes('核心排名内容'));
});

test('取景参数只有一组 coreMargins：历史的两套位移/间距叠加不能复活', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'scripts', 'web-server.mjs'), 'utf8');
  const both = html + server;
  // 两套历史覆盖参数（位移滑块 / 四边间距）及其叠加逻辑不能复活；
  // 现在的唯一入口是 coreMargins，直接在 resolveSafeArea 里覆盖四分区边界。
  assert.equal(
    /labelBandAdjust|bandLeft|applyBandAdjust|readBandAdjust|frameGap|applyFrameGaps|readFrameGaps/.test(both),
    false,
  );
  assert.ok(both.includes('coreMargins'), '四分区边界应通过 coreMargins 调整');
  assert.equal(/border: 1px dashed/.test(html), false, '手机屏幕外框应是实线');
  assert.equal(/rect class="frame"|stroke-dasharray/.test(html), false, '不应再画取景虚线框');
  assert.equal(/mapBleed/.test(fs.readFileSync(configPath, 'utf8')), false, '底图出血参数已删除');
  // 服务端两处链路直接 resolveSafeAreaFor，不再二次加工取景矩形。
  assert.ok((server.match(/resolveSafeAreaFor\(/g) || []).length >= 2);
  const previewBlock = server.slice(
    server.indexOf('if (req.method === "POST" && pathname === "/api/framing/preview")'),
    server.indexOf('if (req.method === "POST" && pathname === "/api/generate")'),
  );
  assert.ok(
    previewBlock.includes('        safeArea,'),
    '预览响应必须回传同一份 safeArea',
  );
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(10)});
  assert.deepEqual(resolution.mapRect, resolution.coreRect);
});

test('coreMargins：四边覆盖同时驱动核心框、取景矩形、压暗带与互动栏', () => {
  const base = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(10)});
  assert.equal(base.coreMarginsApplied, false);
  assert.deepEqual(base.mapRect, base.coreRect);

  const adjusted = resolveSafeArea(config, {
    platform: 'tiktok',
    description: 'x'.repeat(10),
    coreMargins: {top: 300, bottom: 520, left: 120, right: 240},
  });
  assert.equal(adjusted.coreMarginsApplied, true);
  assert.deepEqual(adjusted.margins, {top: 300, bottom: 520, left: 120, right: 240});
  assert.equal(adjusted.coreRect.x0, 120);
  assert.equal(adjusted.coreRect.y0, 300);
  assert.equal(adjusted.coreRect.y1, 1920 - 520);
  // 手动调右边距时互动栏横向同步跟随，核心框右边界只再退一个 contentGapPx。
  assert.equal(adjusted.interactiveRect.x0, 1080 - 240);
  assert.equal(adjusted.interactiveRect.x1, 1080);
  assert.equal(adjusted.coreRect.x1, 1080 - 240 - config.contentGapPx);
  // 唯一的取景矩形与文字边界都等于核心框。
  assert.deepEqual(adjusted.mapRect, adjusted.coreRect);
  assert.deepEqual(adjusted.labelRect, adjusted.coreRect);
  // 四条压暗带同样来自这一组值，不另造边界。
  assert.equal(adjusted.topBandRect.y1, 300);
  assert.equal(adjusted.bottomBandRect.y0, 1920 - 520);
  assert.equal(adjusted.leftBandRect.x1, 120);
  assert.equal(adjusted.rightBandRect.x0, 1080 - 240);

  // 只改一条边时其余三边保持派生值，互动栏仍然跟着右边走。
  const onlyRight = resolveSafeArea(config, {
    platform: 'tiktok',
    description: 'x'.repeat(10),
    coreMargins: {right: 240},
  });
  assert.equal(onlyRight.coreMarginsApplied, true);
  assert.equal(onlyRight.margins.top, base.margins.top);
  assert.equal(onlyRight.margins.bottom, base.margins.bottom);
  assert.equal(onlyRight.margins.left, base.margins.left);
  assert.equal(onlyRight.interactiveRect.x0, 1080 - 240);
  assert.deepEqual(onlyRight.mapRect, onlyRight.coreRect);
});

test('coreMargins：优先于描述分档，非法值逐条告警，过大值收敛', () => {
  const longDescription = 'x'.repeat(260);
  // 抖音 long 档默认 600px，手动给的 500px 必须赢，否则「调了没反应」。
  const overridden = resolveSafeArea(config, {
    platform: 'douyin',
    description: longDescription,
    coreMargins: {bottom: 500},
  });
  assert.equal(overridden.descriptionTier, 'long');
  assert.equal(overridden.margins.bottom, 500);
  assert.equal(overridden.coreMarginsApplied, true);
  assert.equal(overridden.coreRect.y1, 1920 - 500);

  // 非法值只忽略该边，不牵连其余边，也不产生坏布局。
  const bad = resolveSafeArea(config, {
    platform: 'tiktok',
    description: 'x'.repeat(10),
    coreMargins: {top: -5, bottom: 'abc', left: Infinity, right: 200},
  });
  const pristine = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(10)});
  assert.equal(bad.margins.top, pristine.margins.top);
  assert.equal(bad.margins.bottom, pristine.margins.bottom);
  assert.equal(bad.margins.left, pristine.margins.left);
  assert.equal(bad.margins.right, 200);
  assert.equal(bad.coreMarginsApplied, true);
  for (const side of ['top', 'bottom', 'left']) {
    assert.ok(
      bad.warnings.some((line) => line.includes(`coreMargins.${side}`)),
      `${side} 非法应逐条告警`,
    );
  }

  // 非对象 / 空对象都视为「没有手动调整」，回到默认派生。
  const notObject = resolveSafeArea(config, {
    platform: 'tiktok', description: 'x'.repeat(10), coreMargins: 42,
  });
  assert.equal(notObject.coreMarginsApplied, false);
  assert.deepEqual(notObject.margins, pristine.margins);
  assert.ok(notObject.warnings.some((line) => line.includes('coreMargins 必须是')));
  const empty = resolveSafeArea(config, {
    platform: 'tiktok', description: 'x'.repeat(10), coreMargins: {},
  });
  assert.equal(empty.coreMarginsApplied, false);
  assert.deepEqual(empty.coreRect, pristine.coreRect);

  // 超过画布 45% 的边由既有收敛逻辑处理，不会把画面吃光。
  const huge = resolveSafeArea(config, {
    platform: 'tiktok', description: 'x'.repeat(10), coreMargins: {top: 9999},
  });
  assert.equal(huge.margins.top, Math.floor(1920 * 0.45));
  assert.ok(huge.warnings.some((line) => line.includes('45%')));
  assert.ok(huge.coreRect.y1 - huge.coreRect.y0 > 0);
});

test('核心框四边控件：预览图右侧每个参数单独成行，预览与成片同源', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'scripts', 'web-server.mjs'), 'utf8');
  // 上 / 下 / 左 / 右各是一个独立的 label 行，容器是纵向 flex。
  for (const id of ['coreTop', 'coreBottom', 'coreLeft', 'coreRight']) {
    assert.ok(
      new RegExp(`<label>[^<]*<input id="${id}"`).test(html),
      `${id} 应单独成行`,
    );
  }
  assert.ok(
    /\.core-margins-grid\s*\{[^}]*flex-direction:\s*column/.test(html),
    '四个参数应纵向逐行排布',
  );
  assert.ok(/class="framing-side"/.test(html) && /class="preview-col"/.test(html));
  // 预览与成片两条请求都送同一组值；服务端透传给 resolveSafeArea。
  assert.equal((html.match(/coreMargins:\s*coreMarginsState\(\)/g) || []).length, 2);
  assert.ok(/coreMargins:\s*body\?\.coreMargins/.test(server));
  assert.equal(
    (server.match(/resolveSafeAreaFor\(/g) || []).length >= 2,
    true,
    '预览与生成都走同一个安全区入口',
  );
  // 核心框常驻绘制，画的是服务端返回的 coreRect，与遮罩开关无关。
  assert.ok(/class="safe-core"/.test(html));
  assert.ok(/scaleSafeRect\(safeArea\.coreRect/.test(html));
  assert.ok(/重置为平台默认/.test(html));
  // 配置版本号与代码常量一致。
  assert.equal(config.version, SAFE_AREA_CONFIG_VERSION);
  const doc = fs.readFileSync(path.join(root, 'SAFE_AREA.md'), 'utf8');
  assert.ok(doc.includes(`\`${config.version}\``), '文档版本号应与配置一致');
  assert.ok(doc.includes('coreMargins'));
});

test('预览参数列窄化：不再有硬 min-width 撑出横向滚动，取景参数三个一排', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  // 三处曾把参数列顶宽的硬下限必须消失；图列自适应、参数列固定 160px。
  assert.equal(/\.framing-side\s*\{[^}]*min-width:\s*260px/.test(html), false);
  assert.equal(/\.framing-info\s*\{[^}]*min-width:\s*260px/.test(html), false);
  assert.equal(/\.preview-col\s*\{[^}]*min-width:\s*300px/.test(html), false);
  assert.equal(/\.preview-col\s*\{[^}]*width:\s*56%/.test(html), false);
  assert.ok(/\.framing-side\s*\{[^}]*flex:\s*0 0 160px/.test(html));
  assert.ok(/\.preview-col\s*\{[^}]*flex:\s*1 1 auto/.test(html));
  // 「4 / 地图取景」参数三个一排；select 必须能收缩，否则被最长 option 撑开列。
  assert.ok(/class="field-grid framing-main"/.test(html));
  assert.ok(
    /\.card\.row\.actions \.framing-main\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(html),
    '取景参数应三个一排',
  );
  assert.ok(/\.card\.row\.actions select\s*\{[^}]*min-width:\s*0/.test(html));
  assert.ok(/\.card\.row\.actions \.field label\s*\{[^}]*font-size:\s*9px/.test(html));
  // 窄屏要有单列降级，避免三列在小视口里挤坏。
  assert.ok(
    /@media \(max-width: 800px\)[\s\S]*?\.card\.row\.actions \.framing-main\s*\{\s*grid-template-columns:\s*1fr/.test(html),
  );
});

/* -------------------------------------------------------------------------- *
 * 默认参数（2026-11-07.4）：预览页、配置、服务端取景默认值同源
 * -------------------------------------------------------------------------- */

test('默认参数：四边 100/150/10/10、主体右移 0px、取景远近 100% 三处一致', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const viewportSource = fs.readFileSync(
    path.join(root, 'src', 'framing', 'resolveViewport.ts'),
    'utf8',
  );

  // 「2 / 地图取景预览」右侧四个输入框的初始值 = 平台默认四边。
  const defaults = {coreTop: 100, coreBottom: 150, coreLeft: 10, coreRight: 10};
  for (const [id, value] of Object.entries(defaults)) {
    assert.ok(
      new RegExp(`<input id="${id}"[^>]*value="${value}"`).test(html),
      `${id} 初始值应为 ${value}`,
    );
  }
  assert.ok(
    /tiktok:\s*\{top:\s*100,\s*bottom:\s*150,\s*left:\s*10,\s*right:\s*10\}/.test(html),
    '前端「重置为平台默认」的值应与配置一致',
  );
  assert.deepEqual(config.platforms.tiktok.margins, {top: 100, bottom: 150, left: 10, right: 10});
  assert.deepEqual(config.platforms.tiktok.bottomByTier, {short: 150, medium: 150, long: 150});

  // 不传 coreMargins 时，服务端派生出来的四边就是同一组值（预览回填的真值）。
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(120)});
  assert.equal(resolution.coreMarginsApplied, false);
  assert.deepEqual(resolution.margins, {top: 100, bottom: 150, left: 10, right: 10});
  assert.equal(resolution.coreRect.x0, 10);
  assert.equal(resolution.coreRect.y0, 100);
  assert.equal(resolution.coreRect.y1, 1920 - 150);

  // 「4 / 地图取景」：主体右移 0px、取景远近 100%，滑块 / 读数 / JS 兜底 / 服务端四处一致。
  assert.ok(/id="subjectOffsetX"[\s\S]{0,160}value="0"/.test(html));
  assert.ok(/id="subjectOffsetXValue"[^>]*>0px</.test(html));
  assert.ok(/Number\.isFinite\(offsetPx\)\s*\?\s*offsetPx\s*:\s*0/.test(html));
  assert.ok(/const SUBJECT_CENTER_OFFSET_X = 0;/.test(viewportSource));
  assert.equal(resolveViewport(geojson, EAST, {}, MAP_STAGE).subjectOffsetX, 0);

  assert.ok(/id="zoomDistance"[\s\S]{0,160}value="100"/.test(html));
  assert.ok(/id="zoomDistanceValue"[^>]*>100%</.test(html));
  assert.ok(/Number\.isFinite\(zoomPercent\)\s*\?\s*zoomPercent\s*:\s*100/.test(html));
  assert.ok(/zoomDistance:\s*1,/.test(viewportSource));
  assert.equal(resolveViewport(geojson, EAST, {}, MAP_STAGE).zoomDistance, 1);
});

/* -------------------------------------------------------------------------- *
 * 配色：预览与成片同一份色阶，且名次越靠前越深
 * -------------------------------------------------------------------------- */

test('配色：预览页的 RANK_FILL 与 theme.rankFill 逐项相同', () => {
  const html = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html'),
    'utf8',
  );
  const match = /const RANK_FILL = \[([^\]]+)\]/.exec(html);
  assert.ok(match, '预览页应保留 RANK_FILL 色阶常量（预览与成片必须同源）');
  const preview = match[1]
    .split(',')
    .map((value) => value.trim().replace(/["']/g, '').toUpperCase())
    .filter(Boolean);
  assert.deepEqual(preview, theme.rankFill.map((value) => value.toUpperCase()));
});

test('配色：名次越靠前填色越深，且五档落在同一橙色系', () => {
  const luminance = (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (let i = 1; i < theme.rankFill.length; i += 1) {
    assert.ok(
      luminance(theme.rankFill[i]) > luminance(theme.rankFill[i - 1]),
      `第 ${i + 1} 名 (${theme.rankFill[i]}) 应比第 ${i} 名 (${theme.rankFill[i - 1]}) 更浅`,
    );
  }
  // 同一橙色系：红分量最高、蓝分量最低，不与绿色/冷色混用。
  for (const hex of theme.rankFill) {
    const value = Number.parseInt(hex.slice(1), 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    assert.ok(r > g && g > b, `${hex} 不是橙色系（需满足 R > G > B）`);
  }
});

/* -------------------------------------------------------------------------- *
 * 排版与文案：预览与成片共用一份标尺，第一行是 NO.
 * -------------------------------------------------------------------------- */

test('排版：府名行的中心由基线反推，与字号标尺同源', () => {
  assert.ok(
    Math.abs(
      LABEL_NAME_CENTER_Y -
        (LABEL_BASELINE.name - LABEL_FONT_SIZE.name * LABEL_CENTRE_RATIO),
    ) < 1e-9,
    '府名中心必须由 LABEL_BASELINE.name 反推，不能手填',
  );
  // 行的先后与块高：基线递增，块能容下三行。
  assert.ok(LABEL_BASELINE.rank < LABEL_BASELINE.name);
  assert.ok(LABEL_BASELINE.name < LABEL_BASELINE.value);
  assert.ok(
    LABEL_BASELINE.value + LABEL_FONT_SIZE.value * 0.3 <= LABEL_BOX.height,
    '文字块高度要容得下数值行的下伸笔画',
  );
});

test('文案：渲染端与预览都用 NO.xx，不再出现 RANK 前缀', () => {
  const mapSource = fs.readFileSync(
    path.join(root, 'src', 'video', 'components', 'ThailandMap.tsx'),
    'utf8',
  );
  const serverSource = fs.readFileSync(path.join(root, 'scripts', 'web-server.mjs'), 'utf8');
  for (const [name, source] of [
    ['ThailandMap', mapSource],
    ['web-server', serverSource],
  ]) {
    assert.ok(source.includes('NO.'), `${name} 应输出 NO. 前缀`);
    assert.ok(
      !/["'`]RANK /.test(source),
      `${name} 里不应再有写死的 "RANK " 文本`,
    );
  }
  // 字号不许在组件里手写：只能引用共享标尺。
  assert.ok(
    !/fontSize="\d+"/.test(mapSource),
    'ThailandMap 的字号必须来自 LABEL_FONT_SIZE，不能写死数字',
  );
});

test('预览图：排名读数由服务端下发的矩形 + 标尺绘制，不是另算一份', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const serverSource = fs.readFileSync(path.join(root, 'scripts', 'web-server.mjs'), 'utf8');

  // 服务端把 labels / labelStyle 一起回给预览页。
  assert.ok(/labels:\s*rankingLabelsPayload\(/.test(serverSource), '预览响应应带 labels');
  assert.ok(/labelStyle:\s*labelStyle\(\)/.test(serverSource), '预览响应应带 labelStyle');
  assert.ok(
    /placeRankingLabels\(/.test(serverSource) &&
      /auditSafeArea[\s\S]{0,600}placeRankingLabels\(viewport, labelOffsets\)/.test(
        serverSource,
      ),
    '审计与预览必须共用同一份落位实现',
  );

  // 预览页照矩形画三行，带白描边，插入到府形状之后。
  assert.ok(/const labelSvg = \(items, style\)/.test(html), '预览页应有 labelSvg 绘制函数');
  assert.ok(/labelSvg\(labels, labelStyle\)/.test(html), '预览页应把 labels 画进地图');
  assert.ok(/paint-order="stroke"/.test(html), '预览读数需要白色描边（halo）');
  assert.ok(
    /letter-spacing/.test(html) && /text-anchor="middle"/.test(html),
    '预览读数要与成片一样居中、带字距',
  );
});

/* -------------------------------------------------------------------------- *
 * 单位：网页逐行填写 → 预览与成片同口径拼在数值后面
 * -------------------------------------------------------------------------- */

test('单位：每行自定义，UI / 预览 / 成片 / 校验四处同源', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const serverSource = fs.readFileSync(path.join(root, 'scripts', 'web-server.mjs'), 'utf8');
  const mapSource = fs.readFileSync(
    path.join(root, 'src', 'video', 'components', 'ThailandMap.tsx'),
    'utf8',
  );
  const schemaSource = fs.readFileSync(path.join(root, 'src', 'data', 'schema.ts'), 'utf8');
  const typesSource = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf8');

  // 网页：多一列「单位」，每行输入写回 ranking.unit；两个请求都原样上送 data。
  assert.ok(/<th>单位<\/th>/.test(html), '排名数据表应有「单位」列');
  assert.ok(/ranking\.unit = event\.target\.value/.test(html), '单位输入要写回该行数据');
  assert.ok(/rankings: data,/.test(html), '预览与生成请求都要上送含 unit 的 rankings');
  assert.ok(/unit: ""/.test(html), '新增的空行也要带单位字段');

  // 服务端：行级优先、项目级兜底，且不再把项目级单位写死成空串。
  assert.ok(/row\.unit \?\? unit/.test(serverSource), '预览文案要用行级单位优先');
  assert.ok(
    /unit: String\(body\.unit \?\? ""\)/.test(serverSource),
    '生成 props 要透传项目级单位兜底',
  );

  // 渲染端：同一口径拼成一行文本，预览与成片一字不差。
  assert.ok(/datum\.unit \?\? project\.unit/.test(mapSource), '成片读数要用行级单位优先');
  assert.ok(/valueLine/.test(mapSource), '数值与单位应拼成一行文本');

  // zod 默认 strip 未声明字段：类型与 schema 不声明，导入 JSON 时单位会丢。
  assert.ok(/unit\?: string/.test(typesSource), 'RankingDatum 要声明行级单位');
  assert.ok(/unit: z\.string\(\)\.optional\(\)/.test(schemaSource), 'rankingSchema 要保留行级单位');
});

/* -------------------------------------------------------------------------- *
 * 手动微调：预览拖拽 → 生成生效，拖飞了回原位
 * -------------------------------------------------------------------------- */

test('微调：偏移叠加在自动落位上，且记录下叠加量', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  const province = provinceAt(632, 955, 83, 56);
  const auto = placeLabel(labelInput(resolution, province));
  const moved = applyLabelOffset(auto, {dx: 40, dy: -25});

  assert.deepEqual(moved.panelRect, {
    x0: auto.panelRect.x0 + 40,
    y0: auto.panelRect.y0 - 25,
    x1: auto.panelRect.x1 + 40,
    y1: auto.panelRect.y1 - 25,
  });
  assert.deepEqual(moved.manualOffset, {dx: 40, dy: -25});
  assert.deepEqual(auto.manualOffset, undefined, '自动落位不能被就地改写');
});

test('微调：拖过界（单轴超上限）直接回落自动落位', () => {
  const resolution = resolveSafeArea(config, {platform: 'tiktok', description: 'x'.repeat(20)});
  const province = provinceAt(632, 955, 83, 56);
  const auto = placeLabel(labelInput(resolution, province));

  // 恰好等于上限：可用。
  assert.deepEqual(normalizeLabelOffset({dx: MAX_MANUAL_OFFSET_PX, dy: 0}), {
    dx: MAX_MANUAL_OFFSET_PX,
    dy: 0,
  });
  // 超一点就判否 —— 这就是「拖飞了」的判定线。
  assert.equal(normalizeLabelOffset({dx: MAX_MANUAL_OFFSET_PX + 1, dy: 0}), null);
  assert.equal(normalizeLabelOffset({dx: 0, dy: -MAX_MANUAL_OFFSET_PX - 40}), null);
  assert.equal(normalizeLabelOffset({dx: Number.NaN, dy: 0}), null);
  assert.equal(normalizeLabelOffset(null), null);

  // 无效偏移交给 applyLabelOffset 时，位置与自动落位逐像素相同。
  for (const bad of [
    {dx: MAX_MANUAL_OFFSET_PX + 1, dy: 0},
    {dx: 0, dy: 9999},
    {dx: null, dy: 10},
    {dx: '20', dy: 10},
  ]) {
    assert.deepEqual(
      applyLabelOffset(auto, bad).panelRect,
      auto.panelRect,
      `无效偏移 ${JSON.stringify(bad)} 不该改变落位`,
    );
  }
});

test('微调：偏移表规整——键大写、去零位移、丢掉越界项', () => {
  const map = normalizeLabelOffsetMap({
    'th-10': {dx: 12.4, dy: -3.6},
    'TH-20': {dx: 0, dy: 0},
    'TH-21': {dx: MAX_MANUAL_OFFSET_PX + 10, dy: 0},
    '': {dx: 5, dy: 5},
    'TH-50': 'nope',
  });
  assert.deepEqual(map, {'TH-10': {dx: 12, dy: -4}});
  assert.deepEqual(normalizeLabelOffsetMap(undefined), {});
  assert.deepEqual(normalizeLabelOffsetMap(null), {});
});

test('微调：渲染端与服务端用同一套偏移规则（不各写一份）', () => {
  const mapSource = fs.readFileSync(
    path.join(root, 'src', 'video', 'components', 'ThailandMap.tsx'),
    'utf8',
  );
  const serverSource = fs.readFileSync(path.join(root, 'scripts', 'web-server.mjs'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

  // 渲染端：normalizeLabelOffsetMap 规整 + applyLabelOffset 叠加，两者都来自共享模块。
  assert.ok(/normalizeLabelOffsetMap\(project\.labelOffsets\)/.test(mapSource));
  assert.ok(/applyLabelOffset\(/.test(mapSource));

  // 服务端：同一套函数，预览与生成都带上偏移。
  assert.ok(/applyLabelOffset\(auto, offsets\[key\]\)/.test(serverSource));
  assert.ok(/labelOffsets:\s*labelPlacementModule[\s\S]{0,120}normalizeLabelOffsetMap/.test(serverSource));
  assert.ok(/maxOffset:/.test(serverSource), '拖拽上限随 labelStyle 下发，网页不自己写死');

  // 预览页：拖拽 + 一键复位 + 两个请求都带偏移。
  assert.ok(/addEventListener\("pointerdown"/.test(html), '预览图应支持拖拽');
  assert.ok(/dataset\.province/.test(html), '读数分组要带 provinceId 才能记偏移');
  assert.ok(/resetLabelOffsets/.test(html), '应有「恢复自动落位」按钮');
  assert.ok(/localStorage\.setItem\(LABEL_OFFSET_KEY/.test(html), '偏移应跨刷新保留');
  assert.equal(
    (html.match(/labelOffsets,\s*\n?\s*\}\)/g) || []).length >= 1,
    true,
    '预览请求应上送 labelOffsets',
  );
  assert.ok(/labelOffsets,\s*\n\s*rankings: data,/.test(html), '生成请求应上送 labelOffsets');
});

/* -------------------------------------------------------------------------- *
 * 读数生命周期：解说期间在府上，说完就淡出，全部念完再一起回来。
 * -------------------------------------------------------------------------- */

test('生命周期：读数只在 [revealAt, hideAt) 显示，全部念完从 allAt 一起回来', () => {
  const mapSource = fs.readFileSync(
    path.join(root, 'src', 'video', 'components', 'ThailandMap.tsx'),
    'utf8',
  );
  const videoSource = fs.readFileSync(
    path.join(root, 'src', 'video', 'ThailandRankingVideo.tsx'),
    'utf8',
  );

  // 渲染端：hideAt 窗口 + allAt 终场一起入场，落位仍来自 rank 排序的统一地图。
  assert.ok(/readouts\.map\(\(\{datum, revealAt, hideAt\}\)/.test(mapSource), '读数要按 revealAt→hideAt 窗口渲染');
  assert.ok(/inFinale = frame >= allAt/.test(mapSource), '终场一起入场由 allAt 触发');
  // 终场入场点是「最后一句结束 + 静默一拍」，不是最后一句结束的同一帧：留出
  // 停顿，读数才不会「啪一下没了又啪一下回来」。
  assert.ok(
    /allAt=\{timeline\.finaleAt\}/.test(videoSource),
    'allAt 应取 timeline.finaleAt（最后一段结束 + FINALE_PAUSE_SECONDS）',
  );
  assert.ok(/hideAt: segment\.end/.test(videoSource), 'hideAt = 该府解说段结束帧');
  // readouts 不过滤当前帧：位置在整份排名上算，读数提前出现时不会跳位。
  assert.ok(!/segment\.revealAt > frame\) continue;\s*\n\s*const key/.test(videoSource));
  // 填充色与读数显隐分家：点亮集合只看 revealAt。
  assert.ok(/litIdSet/.test(mapSource), '府的点亮状态与读数显隐应分开计算');

  // 服务端算成片长度时必须把这段空拍加进去，否则 audion 与合成时长不同步。
  const serverSource = fs.readFileSync(path.join(root, 'scripts', 'web-server.mjs'), 'utf8');
  assert.ok(
    /timelineModule\?\.FINALE_PAUSE_SECONDS/.test(serverSource),
    '服务端应复用时间轴的 FINALE_PAUSE_SECONDS',
  );
  assert.ok(
    /totalDuration\s*\+\s*\n?\s*finalePauseSeconds/.test(serverSource),
    'videoDuration = 旁白 + 空拍 + 片尾停留，空拍不能吃掉读数时间',
  );
});
