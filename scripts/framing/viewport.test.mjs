/**
 * Data-driven framing tests (scenarios A–G of the framing spec).
 *
 * Run with: npm run test:framing
 *
 * The tests use the real 77-province GeoJSON and the real ISO 3166-2:TH ids, so
 * they exercise the same matching and projection code the render uses. Node
 * executes the TypeScript module directly (type stripping), which keeps a single
 * implementation instead of a duplicated JavaScript copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {geoMercator, geoPath} from 'd3-geo';

import {
  DEFAULT_FRAMING_OPTIONS,
  MAP_OVERLAY_BANDS,
  MAP_SAFE_INSET,
  MAP_STAGE,
  blendViewport,
  createProjection,
  describeViewport,
  normalizeFramingOptions,
  projectFeatures,
  resolveViewport,
  scaleToZoom,
  zoomToScale,
} from '../../src/framing/resolveViewport.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const geojson = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'data', 'thailand-provinces.geo.json'), 'utf8'),
);

const view = (provinceIds, options) =>
  resolveViewport(geojson, provinceIds, options, MAP_STAGE);

/** How much bigger the framing is compared to showing the whole country. */
const zoomRatio = (viewport) => Math.pow(2, viewport.zoom - viewport.referenceZoom);

/* Real province ids, grouped by geography (see the province list in the README). */
const EAST = ['TH-10', 'TH-11', 'TH-13', 'TH-20', 'TH-21', 'TH-22', 'TH-23', 'TH-24', 'TH-25', 'TH-27'];
const SOUTH = ['TH-80', 'TH-81', 'TH-82', 'TH-83', 'TH-84', 'TH-90', 'TH-91', 'TH-92', 'TH-93', 'TH-94'];
const NORTH = ['TH-57', 'TH-50', 'TH-58', 'TH-55', 'TH-56', 'TH-52', 'TH-51', 'TH-54', 'TH-53', 'TH-63'];
const OUTLIER = 'TH-96'; // Narathiwat, deep south

test('zoom 与 d3 scale 的换算可逆', () => {
  for (const zoom of [3, 5.5, 7.01, 9, 12]) {
    assert.ok(Math.abs(scaleToZoom(zoomToScale(zoom)) - zoom) < 1e-9);
  }
  // The legacy 1080x1480 inner box sat at the well known ~7.01 zoom level.
  assert.ok(Math.abs(scaleToZoom(5252.21) - 7.01) < 0.01);
});

test('场景A：排名区域集中时，视口自动偏向该区域并明显放大', () => {
  const full = view(EAST, {fitMode: 'full-country'});
  const framed = view(EAST, {});

  assert.equal(framed.mode, 'data-driven');
  assert.equal(framed.totalCount, EAST.length);
  assert.equal(framed.coverage, 1);
  assert.deepEqual(framed.droppedIds, []);

  // 不要求展示完整泰国地图：取景中心落在东部/中部，而不是国家几何中心。
  assert.ok(framed.center[0] > 100.5 && framed.center[0] < 102.5, `经度 ${framed.center[0]}`);
  assert.ok(framed.center[1] > 12.4 && framed.center[1] < 14.6, `纬度 ${framed.center[1]}`);

  // 重点府在屏幕上明显更大。
  assert.ok(zoomRatio(framed) > 1.5, `相对全图放大 ${zoomRatio(framed).toFixed(2)} 倍`);
  assert.ok(framed.scale > full.scale * 1.5);

  // 排名靠前的小府在取景后拥有足够的像素尺寸。
  const smallest = framed.diagnostics
    .slice()
    .sort((a, b) => a.areaPx - b.areaPx)[0];
  assert.ok(smallest.areaPx > 2000, `最小排名府面积 ${smallest.areaPx}px²`);

  // 松紧程度必须产生真实的视口差异，而不是只有标签不同。
  const tight = view(EAST, {framingPreset: 'tight'});
  const wide = view(EAST, {framingPreset: 'wide'});
  assert.ok(tight.scale >= framed.scale, 'tight 不应比 balanced 更松');
  assert.ok(tight.scale > wide.scale * 1.1, `tight ${tight.scale} vs wide ${wide.scale}`);
});

test('场景B：排名区域集中在南部时，视口移动到南部且不出现极端缩放', () => {
  const south = view(SOUTH, {});
  const north = view(NORTH, {});

  assert.equal(south.coverage, 1);
  assert.ok(south.center[1] < 10, `南部取景中心纬度 ${south.center[1]}`);
  assert.ok(north.center[1] - south.center[1] > 4, '南北取景中心必须明显不同');
  assert.ok(south.center[0] > 98 && south.center[0] < 102, `经度 ${south.center[0]}`);

  // 不使用固定的东部中心点。
  assert.ok(south.center[1] < view(EAST, {}).center[1] - 3, '南部取景不应沿用中部中心');

  // 狭长的半岛地形不应产生不合理的极端缩放。
  assert.ok(zoomRatio(south) > 1.5 && zoomRatio(south) < 6, `放大 ${zoomRatio(south).toFixed(2)} 倍`);
  assert.ok(south.zoom >= DEFAULT_FRAMING_OPTIONS.minZoom);
  assert.ok(south.zoom <= DEFAULT_FRAMING_OPTIONS.maxZoom);
  assert.ok(Number.isFinite(south.scale) && south.scale > 0);
  assert.ok(Number.isFinite(south.translate[0]) && Number.isFinite(south.translate[1]));

  // 南部取景必须仍然装下全部南部排名府。
  assert.deepEqual(south.droppedIds, []);
});

test('场景C：离群排名区域按覆盖阈值权衡，重点区域不会被压小', () => {
  const rankings = [...EAST.slice(0, 9), OUTLIER]; // 9 个东部 + 1 个遥远南部

  // 默认必须全部可见：一个排名项都不能被静默排除。
  const all = view(rankings, {});
  assert.equal(all.coveredCount, 10);
  assert.deepEqual(all.droppedIds, []);

  // 显式把阈值降到 0.9 才允许用离群府换放大。
  // 这里固定 verticalSquash: 0：本用例验证的是「剔除离群府 → 换来放大」这条
  // 算法语义。压扁会压缩南北方向的离群影响，把增益从 1.5× 拉到约 1.1×，
  // 那是另一条特性，不该混进这个断言（压扁后的行为见「纵向压扁」用例）。
  const flat = {verticalSquash: 0};
  const balanced = view(rankings, {coverageThreshold: 0.9, allowOutlierDrop: true, ...flat});

  assert.equal(balanced.totalCount, 10);
  assert.equal(balanced.coveredCount, 9);
  assert.equal(balanced.coverage, 0.9);
  assert.deepEqual(balanced.droppedIds, [OUTLIER]);

  // 离群区域不会被静默删除：数据仍在，且有可定位的提示。
  const diagnostic = balanced.diagnostics.find((item) => item.provinceId === OUTLIER);
  assert.ok(diagnostic, '离群区域必须仍然出现在诊断信息中');
  assert.equal(diagnostic.inside, false);
  assert.ok(diagnostic.outsidePx > 0, '离群区域应记录到画面外的像素距离');
  assert.ok(
    balanced.warnings.some((warning) => warning.includes(OUTLIER)),
    '生成日志必须记录未进入视口的排名区域',
  );

  // 若为了容纳离群区域而缩小，重点区域会变得很小 —— 对比 wide 模式。
  const wide = view(rankings, {framingPreset: 'wide', ...flat});
  assert.deepEqual(wide.droppedIds, [], 'wide 模式应保持全部覆盖');
  assert.ok(
    balanced.scale > wide.scale * 1.5,
    `balanced ${balanced.scale} 应明显大于 wide ${wide.scale}`,
  );

  // 覆盖优先策略：阈值调低后允许丢更多，但不会低于阈值下限。
  const loose = view(rankings, {
    coverageThreshold: 0.5,
    framingPreset: 'tight',
    allowOutlierDrop: true,
  });
  assert.ok(loose.coverage >= 0.5 * 0.8 - 1e-9, 'tight 最多把阈值放宽 20%');
  assert.ok(loose.droppedIds.length >= 1);

  // 严格覆盖模式给出显式提示。
  const strict = view(rankings, {
    coverageThreshold: 0.9,
    allowOutlierDrop: true,
    strictCoverage: true,
  });
  assert.ok(strict.warnings.some((warning) => warning.includes('严格覆盖模式')));

  // 覆盖阈值校验：非法值回退默认（1 = 全部可见）而不是产生不可解释的结果。
  assert.equal(
    view(rankings, {coverageThreshold: 5}).coverageThreshold,
    DEFAULT_FRAMING_OPTIONS.coverageThreshold,
  );
  assert.equal(
    view(rankings, {coverageThreshold: 0}).coverageThreshold,
    DEFAULT_FRAMING_OPTIONS.coverageThreshold,
  );
  assert.equal(
    view(rankings, {coverageThreshold: 'abc'}).coverageThreshold,
    DEFAULT_FRAMING_OPTIONS.coverageThreshold,
  );
});

test('场景D：排名区域南北分散时自动扩大取景，且遵守 zoom 限制', () => {
  const spread = ['TH-57', 'TH-50', 'TH-10', 'TH-20', 'TH-83', OUTLIER];
  const framed = view(spread, {});

  // 覆盖阈值 0.9 × 6 条 = floor(5.4) = 5：最多剔 1 个，且只可能是增益最大的
  // 最南离群府；剔除后 zoom 增益必须仍然很小（分散数据不值得大幅放大）。
  assert.ok(framed.coverage >= 5 / 6, `覆盖 ${framed.coverage}`);
  assert.ok(
    framed.droppedIds.every((id) => id === OUTLIER),
    `只允许剔离群府：${framed.droppedIds}`,
  );
  assert.ok(zoomRatio(framed) < 1.2, `分散数据不应放大：${zoomRatio(framed).toFixed(2)} 倍`);
  assert.ok(framed.center[1] > 10 && framed.center[1] < 18, `中心纬度 ${framed.center[1]}`);
  assert.ok(framed.zoom >= DEFAULT_FRAMING_OPTIONS.minZoom);
  assert.ok(framed.zoom <= DEFAULT_FRAMING_OPTIONS.maxZoom);

  // 明确的取景结果说明。
  const summary = describeViewport(framed);
  assert.ok(summary.some((line) => line.includes('覆盖')));
  assert.ok(summary.some((line) => line.includes('zoom')));

  // 不出现无限缩小：极端 minZoom 会被收敛并给出警告。
  const clamped = view(spread, {minZoom: 9, maxZoom: 11});
  assert.ok(Math.abs(clamped.zoom - 9) < 1e-6, `应收敛到 minZoom，实际 ${clamped.zoom}`);
  assert.ok(clamped.warnings.some((warning) => warning.includes('超出限制')));

  // 单点数据不会出现除零或无限放大。
  const single = view(['TH-10'], {});
  assert.ok(Number.isFinite(single.scale));
  assert.ok(single.zoom <= DEFAULT_FRAMING_OPTIONS.maxZoom, `单区域 zoom ${single.zoom}`);
  assert.equal(single.coverage, 1);
});

test('场景E：异常输入使用回退策略并给出可定位信息，不抛异常', () => {
  // 排名数据为空。
  const empty = view([], {});
  assert.equal(empty.mode, 'full-country');
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.coverage, 0);
  assert.ok(empty.warnings.some((warning) => warning.includes('回退为完整国家地图')));

  // 全部区域无法匹配 GeoJSON：仍返回可用的完整国家视口。
  const unmatched = view(['TH-999', 'NOT-A-PROVINCE'], {});
  assert.deepEqual(unmatched.missingIds, ['TH-999', 'NOT-A-PROVINCE']);
  assert.equal(unmatched.coveredCount, 0);
  assert.equal(unmatched.mode, 'full-country');
  assert.ok(unmatched.warnings.some((warning) => warning.includes('TH-999')));
  assert.ok(Number.isFinite(unmatched.scale) && unmatched.scale > 0);

  // 重复区域只计一次，且不会把未参与排名的区域当作排名区域。
  const duplicate = view(['TH-10', 'TH-10', 'TH-20'], {});
  assert.equal(duplicate.totalCount, 2);
  assert.deepEqual(duplicate.keptIds.slice().sort(), ['TH-10', 'TH-20']);
  assert.ok(duplicate.warnings.some((warning) => warning.includes('重复')));

  // id 大小写与空白容错（仍不使用名称匹配）。
  const loose = view([' th-10 ', 'TH-20'], {});
  assert.equal(loose.totalCount, 2);
  assert.equal(loose.missingIds.length, 0);

  // 部分 GeoJSON 几何无效。
  const broken = {
    ...geojson,
    features: [
      ...geojson.features,
      {type: 'Feature', properties: {provinceId: 'TH-XXX', provinceEn: 'Broken'}, geometry: null},
    ],
  };
  const brokenView = resolveViewport(broken, ['TH-10', 'TH-XXX'], {}, MAP_STAGE);
  assert.deepEqual(brokenView.missingIds, ['TH-XXX']);
  assert.ok(brokenView.warnings.some((warning) => warning.includes('几何无效')));
  assert.ok(Number.isFinite(brokenView.scale) && brokenView.scale > 0);

  // 覆盖阈值 / 枚举 / zoom / 手动参数非法：一律回退并报告。
  const normalized = normalizeFramingOptions({
    fitMode: 'nope',
    framingPreset: 'nope',
    coverageThreshold: -1,
    padding: 9,
    minZoom: 12,
    maxZoom: 5,
    manualCenter: [999, 999],
    manualZoom: 'abc',
  });
  assert.equal(normalized.options.fitMode, DEFAULT_FRAMING_OPTIONS.fitMode);
  assert.equal(normalized.options.framingPreset, DEFAULT_FRAMING_OPTIONS.framingPreset);
  assert.equal(normalized.options.coverageThreshold, DEFAULT_FRAMING_OPTIONS.coverageThreshold);
  assert.ok(normalized.options.maxZoom > normalized.options.minZoom);
  assert.equal(normalized.options.manualCenter, undefined);
  assert.ok(normalized.warnings.length >= 5, `应报告全部非法项：${normalized.warnings.length}`);

  // 地图容器宽高异常：回退设计稿尺寸并告警。
  const badStage = resolveViewport(geojson, EAST, {}, {width: 0, height: NaN});
  assert.deepEqual(badStage.stage, MAP_STAGE);
  assert.ok(badStage.warnings.some((warning) => warning.includes('容器宽高异常')));
  assert.ok(badStage.zoom > 0);
});

test('场景F：不同视频数据互相隔离，相同输入可复现', () => {
  const first = view(EAST, {});
  const second = view(SOUTH, {});

  // 第二个视频重新计算自己的视口，不复用第一个的中心与 zoom。
  assert.notEqual(second.scale, first.scale);
  assert.notEqual(second.center[1], first.center[1]);

  // 相同输入 + 相同配置 → 完全一致（包括走缓存的路径）。
  const again = view([...EAST], {});
  assert.equal(again.scale, first.scale);
  assert.deepEqual(again.translate, first.translate);
  assert.deepEqual(again.center, first.center);

  // 同一集合、不同排名顺序 → 同一视口（取景只用集合，不看当前播放项）。
  const reversed = view([...EAST].reverse(), {});
  assert.equal(reversed.scale, first.scale);
  assert.deepEqual(reversed.center, first.center);

  // 参数不同的任务互不污染。
  const tight = view(EAST, {framingPreset: 'tight'});
  assert.notEqual(tight.scale, first.scale);
  assert.equal(view(EAST, {}).scale, first.scale);
});

test('场景G：full-country 与 manual 模式，以及原有行为兼容', () => {
  // full-country 依旧展示完整国家。画布是整幅 1080x1920，但地图从标题带下沿
  // 开始，可用的竖向空间与旧版 1080x1480 内缩框相当，所以尺寸也相当（略大）。
  const legacy = geoMercator().fitExtent([[105, 35], [975, 1435]], geojson);
  const full = view(EAST, {fitMode: 'full-country'});
  assert.equal(full.mode, 'full-country');
  assert.deepEqual(full.stage, MAP_STAGE);
  assert.ok(
    full.scale > legacy.scale(),
    `full-country ${full.scale} 应不小于旧版 ${legacy.scale()}`,
  );
  assert.equal(full.coverage, 1);

  // 完整国家必须整个落在画布内（否则“全图模式”名不副实）。
  const bounds = geoPath(createProjection(full)).bounds(geojson);
  assert.ok(bounds[0][0] >= -1 && bounds[0][1] >= -1, `左上越界 ${JSON.stringify(bounds[0])}`);
  assert.ok(
    bounds[1][0] <= MAP_STAGE.width + 1 && bounds[1][1] <= MAP_STAGE.height + 1,
    `右下越界 ${JSON.stringify(bounds[1])}`,
  );

  // full-country 不受排名数据影响，始终展示整个国家。
  assert.equal(view(['TH-999'], {fitMode: 'full-country'}).coverage, 0);
  assert.equal(view([], {fitMode: 'full-country'}).mode, 'full-country');

  // manual 精确使用用户指定的中心与 zoom。
  const manual = view(EAST, {fitMode: 'manual', manualCenter: [100.5, 13.5], manualZoom: 8});
  assert.equal(manual.mode, 'manual');
  assert.ok(Math.abs(manual.center[0] - 100.5) < 1e-6);
  assert.ok(Math.abs(manual.center[1] - 13.5) < 1e-6);
  assert.ok(Math.abs(manual.zoom - 8) < 1e-6);

  // 手动 zoom 超出限制会被收敛并告警。
  const clamped = view(EAST, {fitMode: 'manual', manualCenter: [100.5, 13.5], manualZoom: 99});
  assert.ok(clamped.zoom <= DEFAULT_FRAMING_OPTIONS.maxZoom);
  assert.ok(clamped.warnings.some((warning) => warning.includes('manualZoom')));

  // manual 缺少中心 → 回退 data-driven，并给出明确提示。
  const manualWithoutCenter = view(EAST, {fitMode: 'manual'});
  assert.equal(manualWithoutCenter.mode, 'data-driven');
  assert.equal(manualWithoutCenter.requestedMode, 'manual');
  assert.ok(manualWithoutCenter.warnings.some((warning) => warning.includes('manualCenter')));

  // 切换模式后旧的自动取景结果不会覆盖新模式。
  assert.equal(view(EAST, {fitMode: 'data-driven'}).mode, 'data-driven');
  assert.equal(view(EAST, {fitMode: 'full-country'}).mode, 'full-country');
  assert.equal(view(EAST, {}).scale, view(EAST, {fitMode: 'data-driven'}).scale);
});

test('地图避开标题带与页脚带：上下都留出遮盖区', () => {
  // 画布就是整幅 1080x1920 设计稿。
  assert.deepEqual(MAP_STAGE, {width: 1080, height: 1920});

  const framed = view(EAST, {});
  // 横向铺满，只留一点贴边安全边距。
  assert.ok(framed.rect.x1 - framed.rect.x0 > MAP_STAGE.width * 0.8);
  // 纵向：上边缘不进入标题带（大标题不再压住任何排名区域），下边缘停在页脚带
  // 之上（手机底部的字幕/按钮同样不压住区域）。preset 的 padding 在此基础上再内缩。
  assert.equal(MAP_SAFE_INSET.top, MAP_OVERLAY_BANDS.top);
  assert.equal(MAP_SAFE_INSET.bottom, MAP_OVERLAY_BANDS.bottom);
  assert.ok(
    framed.rect.y0 >= MAP_OVERLAY_BANDS.top,
    `rect.y0 ${framed.rect.y0} 落进了标题带`,
  );
  assert.ok(
    framed.rect.y1 <= MAP_STAGE.height - MAP_OVERLAY_BANDS.bottom,
    `rect.y1 ${framed.rect.y1} 进入页脚带`,
  );
  const usableHeight = MAP_STAGE.height - MAP_OVERLAY_BANDS.top - MAP_SAFE_INSET.bottom;
  assert.ok(
    framed.rect.y1 - framed.rect.y0 > usableHeight * 0.85,
    `rect 高度 ${framed.rect.y1 - framed.rect.y0} vs 可用 ${usableHeight}`,
  );
  // 底部留白是用户明确要的距离，不是取整误差。
  assert.ok(
    MAP_STAGE.height - framed.rect.y1 >= MAP_OVERLAY_BANDS.bottom,
    `底部留白 ${MAP_STAGE.height - framed.rect.y1}px 不足 ${MAP_OVERLAY_BANDS.bottom}px`,
  );

  // 浮动标签的安全区同样避开标题与页脚，标签文字不会被遮罩压住。
  assert.ok(framed.labelRect.y0 >= MAP_OVERLAY_BANDS.top);
  assert.ok(framed.labelRect.y1 <= MAP_STAGE.height - MAP_OVERLAY_BANDS.bottom);
  assert.ok(framed.labelRect.y0 < framed.labelRect.y1);

  // 相比旧版内缩画布，地图明显更大（这是需求的直接目标）。
  const legacy = geoMercator().fitExtent([[105, 35], [975, 1435]], geojson);
  assert.ok(
    framed.scale > legacy.scale() * 2,
    `相对旧版放大 ${(framed.scale / legacy.scale()).toFixed(2)}x`,
  );

  // 画布变大不影响固定镜头：视口只算一次，逐帧重建完全一致。
  assert.equal(createProjection(framed).scale(), framed.scale);
  assert.deepEqual(createProjection(framed).translate(), createProjection(framed).translate());
});

test('zoom 被收敛后视口仍以目标区域为中心，不产生漂移', () => {
  // 单个小府会算出远超 maxZoom 的比例尺；收敛后必须仍然把它摆回画面中心。
  const single = view(['TH-10'], {maxZoom: 9});
  assert.ok(Math.abs(single.zoom - 9) < 1e-6, `zoom ${single.zoom}`);
  assert.ok(single.warnings.some((warning) => warning.includes('超出限制')));
  assert.ok(single.warnings.some((warning) => warning.includes('9')));

  const feature = geojson.features.find((item) => item.properties.provinceId === 'TH-10');
  const bounds = geoPath(createProjection(single)).bounds(feature);
  const centerX = (bounds[0][0] + bounds[1][0]) / 2;
  const centerY = (bounds[0][1] + bounds[1][1]) / 2;
  const rectCenterX = (single.rect.x0 + single.rect.x1) / 2;
  const rectCenterY = (single.rect.y0 + single.rect.y1) / 2;
  assert.ok(Math.abs(centerX - rectCenterX) < 3, `横向漂移 ${(centerX - rectCenterX).toFixed(2)}px`);
  assert.ok(Math.abs(centerY - rectCenterY) < 3, `纵向漂移 ${(centerY - rectCenterY).toFixed(2)}px`);

  // 收敛只影响比例尺上限，不影响可复现性。
  const again = view(['TH-10'], {maxZoom: 9});
  assert.equal(again.scale, single.scale);
  assert.deepEqual(again.translate, single.translate);
});

test('取景结果可被精确重建：预览与最终渲染共用同一投影', () => {
  const framed = view(EAST, {});

  const rebuilt = createProjection(framed);
  assert.equal(rebuilt.scale(), framed.scale);
  assert.deepEqual(rebuilt.translate(), framed.translate);

  const paths = projectFeatures(framed, geojson);
  assert.equal(paths.length, geojson.features.length, '所有行政区都必须被绘制');
  assert.ok(paths.every((item) => item.id && item.d.startsWith('M')));
  assert.ok(paths.some((item) => item.id === 'TH-10' && item.name === 'Bangkok'));

  // 每一帧都从同一个 viewport 构造投影 → 单帧内不存在第二套中心/缩放。
  const laterFrame = createProjection(framed);
  assert.deepEqual(laterFrame.translate(), rebuilt.translate());
});

test('缓存有效且 77 个排名区域的规模可控', () => {
  const all = geojson.features.map((feature) => feature.properties.provinceId);

  const started = Date.now();
  const framed = view(all, {});
  const elapsed = Date.now() - started;
  assert.equal(framed.totalCount, all.length);
  assert.ok(elapsed < 3000, `77 个区域取景耗时 ${elapsed}ms`);

  const cachedStarted = Date.now();
  const cached = view(all, {});
  assert.ok(Date.now() - cachedStarted < 30, '相同输入必须命中缓存');
  assert.equal(cached.scale, framed.scale);
});

test('开场运镜：两端就是「全图」和「取景」两个视口，中间单调推进且画面中心不漂', () => {
  const ids = EAST;
  const intro = view(ids, {fitMode: 'full-country'});
  const target = view(ids, {});

  // 端点即两个已解析的视口：起帧是全景，落帧是 data-driven 取景。
  assert.equal(blendViewport(intro, target, 0), intro);
  assert.equal(blendViewport(intro, target, 1), target);
  // 越界进度按端点夹紧，不会飞过头。
  assert.equal(blendViewport(intro, target, -1), intro);
  assert.equal(blendViewport(intro, target, 2), target);

  const cx = (target.rect.x0 + target.rect.x1) / 2;
  const cy = (target.rect.y0 + target.rect.y1) / 2;
  let previousZoom = intro.zoom;
  for (const progress of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const mid = blendViewport(intro, target, progress);
    assert.ok(mid.zoom > previousZoom, `zoom 必须单调推进：${progress} → ${mid.zoom}`);
    previousZoom = mid.zoom;
    // 目标区域始终落在画面中心：镜头平移的是地理，不是把地图推出取景框。
    const projected = createProjection(mid)(mid.center);
    assert.ok(Math.abs(projected[0] - cx) < 1e-6, `x 偏移 ${projected[0] - cx}`);
    assert.ok(Math.abs(projected[1] - cy) < 1e-6, `y 偏移 ${projected[1] - cy}`);
    // 中心不会跑到泰国以外（经度 97~106，纬度 5~21）。
    assert.ok(mid.center[0] > 97 && mid.center[0] < 106, `中心经度 ${mid.center[0]}`);
    assert.ok(mid.center[1] > 5 && mid.center[1] < 21, `中心纬度 ${mid.center[1]}`);
  }

  // 中点取 zoom 的对数中点（等比推进，观感速度均匀）。
  const half = blendViewport(intro, target, 0.5);
  assert.ok(Math.abs(half.zoom - (intro.zoom + target.zoom) / 2) < 1e-9);
  // 非相机字段沿用落点视口：取景框、标签安全区不随运镜变化。
  assert.deepEqual(half.rect, target.rect);
  assert.deepEqual(half.labelRect, target.labelRect);

  // 起止本来就一致（例如取景模式就是 full-country）时，运镜是空操作。
  const sameCountry = view(ids, {fitMode: 'full-country'});
  const still = blendViewport(sameCountry, sameCountry, 0.5);
  assert.equal(still.zoom, sameCountry.zoom);
  // 浮点重算会有 ~1e-12 的误差，只要视觉上完全不动即可。
  assert.ok(Math.abs(still.translate[0] - sameCountry.translate[0]) < 1e-6);
  assert.ok(Math.abs(still.translate[1] - sameCountry.translate[1]) < 1e-6);
});

test('开场运镜开关：默认开启，cameraMove=false 会写进视口并给出语义', () => {
  assert.equal(view(EAST, {}).cameraMove, true);
  assert.equal(view(EAST, {cameraMove: false}).cameraMove, false);
  const {warnings} = normalizeFramingOptions({cameraMove: 'yes'});
  assert.ok(warnings.some((warning) => warning.includes('cameraMove')));
});

test('跨度再大也不剔除：极端南北链保持全覆盖，且最多退到全景（不会比全景更小）', () => {
  // 清莱（最北）+ 那拉提瓦（最南）：任何更大的跨度都不存在了。
  const extreme = ['TH-57', 'TH-96'];
  const framed = view(extreme, {});
  const full = view(extreme, {fitMode: 'full-country'});

  assert.equal(framed.coveredCount, 2, '最北与最南必须同时可见');
  assert.deepEqual(framed.droppedIds, []);
  assert.ok(
    framed.zoom >= full.zoom - 1e-6,
    `取景不应比全景更小：${framed.zoom} < ${full.zoom}`,
  );
  assert.ok(
    Math.abs(framed.zoom - full.zoom) < 1e-6,
    `全国跨度应正好退到全景：${framed.zoom} vs ${full.zoom}`,
  );
  // 全景兜底用的是整块可用区，不再额外内缩 padding。
  assert.ok(
    framed.rect.y1 - framed.rect.y0 <= framed.stage.height,
    '全景兜底必须用满可用区',
  );

  // 全部府：就是标准全景，且一个都不少。
  const all = view(
    geojson.features.map((feature) => feature.properties.provinceId),
    {},
  );
  assert.equal(all.coveredCount, 77);
  assert.equal(all.coverage, 1);
  assert.ok(Math.abs(all.zoom - full.zoom) < 1e-6, `77 府应等于全景：${all.zoom}`);

  // 稍小于全国的集合仍然放大（不会因为兜底被压成全景）。
  const six = view(['TH-54', 'TH-56', 'TH-57', 'TH-64', 'TH-65', 'TH-86'], {});
  assert.equal(six.coveredCount, 6);
  assert.ok(six.zoom > full.zoom + 0.1, `6 府应比全景更近：${six.zoom}`);
});

test('旧客户端只发 coverageThreshold=0.9 也绝不会隐藏排名府（必须显式 allowOutlierDrop）', () => {
  const rankings = [...EAST.slice(0, 9), OUTLIER];

  // 老页面 / 老请求体里残留的 0.9：没有开关就不能生效。
  const legacy = view(rankings, {coverageThreshold: 0.9});
  assert.equal(legacy.allowOutlierDrop, false);
  assert.equal(legacy.coverageThreshold, 1, '未开启剔除时阈值必须被夹到 1');
  assert.equal(legacy.coveredCount, 10);
  assert.deepEqual(legacy.droppedIds, []);
  assert.ok(
    legacy.warnings.some((warning) => warning.includes('allowOutlierDrop')),
    '必须给出可定位的提示',
  );

  // 显式开启之后才允许用离群府换放大。
  const optIn = view(rankings, {coverageThreshold: 0.9, allowOutlierDrop: true});
  assert.equal(optIn.allowOutlierDrop, true);
  assert.equal(optIn.coveredCount, 9);
  assert.deepEqual(optIn.droppedIds, [OUTLIER]);

  // 非布尔值不会被当作开启。
  assert.equal(view(rankings, {allowOutlierDrop: 'yes'}).allowOutlierDrop, false);
});

test('南北长链：国土左右留白必须对称（画面里不偏左也不偏右）', () => {
  const cases = {
    泰北5府加春蓬: ['TH-54', 'TH-56', 'TH-57', 'TH-64', 'TH-65', 'TH-86'],
    极北加极南: ['TH-57', 'TH-96'],
    南北加东西: ['TH-57', 'TH-96', 'TH-58', 'TH-22'],
  };
  for (const [name, ids] of Object.entries(cases)) {
    const framed = view(ids, {});
    assert.equal(framed.coveredCount, ids.length, `${name}：排名府必须全部可见`);

    const path = geoPath(createProjection(framed));
    const [[x0], [x1]] = path.bounds(geojson);
    const left = x0;
    const right = MAP_STAGE.width - x1;
    const center = (x0 + x1) / 2;

    // 国土在画面内的左右留白必须相等（容差 2px，只有取整误差）。
    assert.ok(
      Math.abs(left - right) < 2,
      `${name}：左留白 ${left.toFixed(1)} / 右留白 ${right.toFixed(1)} 不对称`,
    );
    // 并且国土中心就是画布中心。
    assert.ok(
      Math.abs(center - MAP_STAGE.width / 2) < 2,
      `${name}：国土中心 ${center.toFixed(1)} 偏离画布中心 ${MAP_STAGE.width / 2}`,
    );
    // 排名府仍然全部落在画面里（居中不会把任何一个推出取景框）。
    for (const diagnostic of framed.diagnostics) {
      assert.ok(diagnostic.inside, `${name}：${diagnostic.provinceId} 被推出了画面`);
    }
  }
});

test('能贴着两侧时就不要留空：跨度覆盖全国宽度时左右留白几乎为零', () => {
  // 泰北 5 府 + 春蓬：纵向被排名府撑满，横向刚好铺到画布两侧。
  const framed = view(['TH-54', 'TH-56', 'TH-57', 'TH-64', 'TH-65', 'TH-86'], {});
  const path = geoPath(createProjection(framed));
  const [[x0], [x1]] = path.bounds(geojson);
  const left = x0;
  const right = MAP_STAGE.width - x1;
  assert.ok(Math.abs(left - right) < 2, `左右不对称：${left.toFixed(1)} / ${right.toFixed(1)}`);
  assert.ok(left < MAP_STAGE.width * 0.05, `左右留白应几乎为零，实际 ${left.toFixed(1)}px`);
  assert.ok(right < MAP_STAGE.width * 0.05, `左右留白应几乎为零，实际 ${right.toFixed(1)}px`);
});
