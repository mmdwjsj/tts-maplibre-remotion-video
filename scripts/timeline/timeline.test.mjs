/**
 * 时间轴的三条硬约束：
 *  1. 一行旁白拆成两段：名次（`อันดับ 3`）和府名，府名**一开口**就点亮该府；
 *  2. 名次播报期间画面保持上一个已揭晓的府；
 *  3. 标题只活到开场白说完为止。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimeline,
  findRevealedSegmentIndex,
} from '../../src/timeline/buildTimeline.ts';

const FPS = 30;

/**
 * 和 web-server 写进 props 的形状一致：开场白 + 3、2、1 名，每个名次两段。
 * 3 名：0.5s 名次 + 1.5s 府名；2 名：1s + 2s；1 名：0.5s + 1.5s。
 */
const project = (overrides = {}) => ({
  title: 'THAILAND PROVINCE RANKING',
  locale: 'th',
  fps: FPS,
  rankings: [
    {rank: 1, provinceId: 'TH-10', provinceEn: 'Bangkok', provinceTh: 'กรุงเทพมหานคร', value: 12500},
    {rank: 2, provinceId: 'TH-50', provinceEn: 'Chiang Mai', provinceTh: 'เชียงใหม่', value: 9800},
    {rank: 3, provinceId: 'TH-45', provinceEn: 'Roi Et', provinceTh: 'ร้อยเอ็ด', value: 8600},
  ],
  audioSegments: [
    {type: 'opening', duration: 1, gapAfter: 1},
    {type: 'ranking', rank: 3, part: 'rank', duration: 0.5, gapAfter: 0},
    {type: 'ranking', rank: 3, part: 'name', duration: 1.5, gapAfter: 1},
    {type: 'ranking', rank: 2, part: 'rank', duration: 1, gapAfter: 0},
    {type: 'ranking', rank: 2, part: 'name', duration: 2, gapAfter: 1},
    {type: 'ranking', rank: 1, part: 'rank', duration: 0.5, gapAfter: 0},
    {type: 'ranking', rank: 1, part: 'name', duration: 1.5, gapAfter: 0},
  ],
  ...overrides,
});

test('一行旁白拆成「名次 + 府名」两段，府名段与名次段共享同一个点亮时刻', () => {
  const timeline = buildTimeline(project());

  assert.deepEqual(
    timeline.segments.map((segment) => segment.part),
    ['opening', 'rank', 'name', 'rank', 'name', 'rank', 'name'],
  );

  // 开场白 1s(+1s 静音)，3 名 0.5+1.5，2 名 1+2，1 名 0.5+1.5。
  assert.deepEqual(
    timeline.segments.map((segment) => ({
      start: segment.start,
      duration: segment.duration,
      revealAt: segment.revealAt,
      end: segment.end,
    })),
    [
      {start: 0, duration: 30, revealAt: 30, end: 60},
      {start: 60, duration: 15, revealAt: 75, end: 75},
      {start: 75, duration: 45, revealAt: 75, end: 150},
      {start: 150, duration: 30, revealAt: 180, end: 180},
      {start: 180, duration: 60, revealAt: 180, end: 270},
      {start: 270, duration: 15, revealAt: 285, end: 285},
      {start: 285, duration: 45, revealAt: 285, end: 330},
    ],
  );

  // 每段都没有空隙：名次段结束的那一刻就是府名段开始的那一刻。
  timeline.segments.slice(1).forEach((segment, index) => {
    assert.equal(segment.start, timeline.segments[index].end);
  });

  // 只有府名段带 datum：名次播报期间没有可点亮的府。
  assert.deepEqual(
    timeline.segments.map((segment) => segment.datum?.rank),
    [undefined, undefined, 3, undefined, 2, undefined, 1],
  );

  // 播报顺序是最低名次优先，1 名最后亮。
  const nameSegments = timeline.segments.filter((segment) => segment.part === 'name');
  assert.deepEqual(nameSegments.map((segment) => segment.datum?.rank), [3, 2, 1]);
  // 每个府恰好一段府名旁白，不会重复点亮。
  assert.equal(new Set(nameSegments.map((segment) => segment.datum?.provinceId)).size, 3);
});

test('逐帧判定：名次一说完（府名开口）就点亮，并保持到下一个府名开口', () => {
  const {segments} = buildTimeline(project());

  // 开场白播报中（0..30 帧）什么都不亮。
  assert.equal(findRevealedSegmentIndex(segments, 0), -1);
  assert.equal(findRevealedSegmentIndex(segments, 29), -1);
  // 开场白说完（第 30 帧）仍没有府可亮，标题只由开场白决定。
  assert.equal(segments[findRevealedSegmentIndex(segments, 30)].datum, undefined);

  // 「อันดับ 3」播报期间（60..74 帧）还不亮……
  assert.equal(segments[findRevealedSegmentIndex(segments, 60)].datum, undefined);
  assert.equal(segments[findRevealedSegmentIndex(segments, 74)].datum, undefined);
  // ……第 75 帧名次刚说完、府名开口，3 号立刻点亮。
  assert.equal(segments[findRevealedSegmentIndex(segments, 75)].datum?.rank, 3);
  assert.equal(segments[findRevealedSegmentIndex(segments, 149)].datum?.rank, 3);

  // 「อันดับ 2」播报期间保持 3 号，府名一开口才切到 2 号。
  assert.equal(segments[findRevealedSegmentIndex(segments, 150)].datum?.rank, 3);
  assert.equal(segments[findRevealedSegmentIndex(segments, 179)].datum?.rank, 3);
  assert.equal(segments[findRevealedSegmentIndex(segments, 180)].datum?.rank, 2);

  // 「อันดับ 1」同理，之后一直亮到结尾，不会被清空。
  assert.equal(segments[findRevealedSegmentIndex(segments, 284)].datum?.rank, 2);
  assert.equal(segments[findRevealedSegmentIndex(segments, 285)].datum?.rank, 1);
  assert.equal(segments[findRevealedSegmentIndex(segments, 9999)].datum?.rank, 1);
});

test('标题在开场白说完后消失；没有开场白时不出来瞎猜', () => {
  const withOpening = buildTimeline(project());
  assert.equal(withOpening.titleEndFrames, 30);

  const withoutOpening = buildTimeline(
    project({
      audioSegments: [
        {type: 'ranking', rank: 3, part: 'rank', duration: 0.5, gapAfter: 0},
        {type: 'ranking', rank: 3, part: 'name', duration: 1.5, gapAfter: 1},
        {type: 'ranking', rank: 2, part: 'rank', duration: 1, gapAfter: 0},
        {type: 'ranking', rank: 2, part: 'name', duration: 2, gapAfter: 0},
      ],
    }),
  );
  assert.equal(withoutOpening.titleEndFrames, 0);
  // 没有开场白时第一段就是名次段，取景/高亮不受影响。
  assert.equal(withoutOpening.segments[0].part, 'rank');
  assert.equal(withoutOpening.segments[0].datum, undefined);
  assert.equal(withoutOpening.segments[1].datum?.rank, 3);
});

test('旧 props（没有 part，一行一段）：仍在整行说完时点亮，不会被误判成府名段', () => {
  const {segments} = buildTimeline(
    project({
      audioSegments: [
        {type: 'opening', duration: 1, gapAfter: 1},
        {type: 'ranking', rank: 3, duration: 2, gapAfter: 1},
        {type: 'ranking', rank: 2, duration: 3, gapAfter: 0},
      ],
    }),
  );

  assert.deepEqual(segments.map((segment) => segment.part), ['opening', 'line', 'line']);
  // line = 名次与府名同段，所以整行说完才亮。
  assert.deepEqual(
    segments.map((segment) => segment.revealAt),
    [30, 120, 240],
  );
  assert.equal(segments[findRevealedSegmentIndex(segments, 119)].datum, undefined);
  assert.equal(segments[findRevealedSegmentIndex(segments, 120)].datum?.rank, 3);
});

test('没有音频元数据时退回名义时长，同样按名次/府名两段切分', () => {
  const timeline = buildTimeline(
    project({
      audioSegments: undefined,
      introDuration: 0,
      finalHoldDuration: 0,
      rankings: [
        {rank: 1, provinceId: 'TH-10', provinceEn: 'Bangkok', provinceTh: 'กรุงเทพมหานคร', value: 1, narrationDuration: 2},
        {rank: 2, provinceId: 'TH-50', provinceEn: 'Chiang Mai', provinceTh: 'เชียงใหม่', value: 2, narrationDuration: 3},
      ],
    }),
  );

  // introDuration 0 → 标题不再靠静音片头。
  assert.equal(timeline.titleEndFrames, 0);
  assert.deepEqual(
    timeline.segments.map((segment) => segment.part),
    ['rank', 'name', 'rank', 'name'],
  );
  assert.deepEqual(
    timeline.segments.map((segment) => segment.datum?.rank),
    [undefined, 2, undefined, 1],
  );
  // 名次段占 20%，府名段拿到剩下的 80%：1.5s → 18 帧名次 + 72 帧府名。
  timeline.segments.forEach((segment) => {
    assert.ok(segment.duration > 0);
    assert.ok(segment.revealAt >= segment.start);
    assert.ok(segment.revealAt <= segment.end);
  });
  const name = timeline.segments[1];
  assert.equal(name.revealAt, name.start);
  assert.equal(name.duration, 72);
});

test('开场运镜窗口正好等于开场白：开口起、说完停', () => {
  const timeline = buildTimeline(project());
  const opening = timeline.segments[0];

  assert.equal(opening.part, 'opening');
  // 开场白 1s：运镜从第 0 帧到第 30 帧，和旁白完全重合（不含 1s 静音尾巴）。
  assert.deepEqual(timeline.camera, {start: opening.start, end: opening.revealAt});
  assert.deepEqual(timeline.camera, {start: 0, end: 30});
  // 运镜在开口说完那一帧就停住；开场白后的 1s 静音里镜头已经是静止的了，
  // 所以第一个名次段开始时绝不会还在动。
  assert.ok(timeline.camera.end <= timeline.segments[1].start);
  assert.equal(timeline.segments[1].start - timeline.camera.end, 30);
  // 标题也是开场白说完才消失，所以「全景 + 标题」这一帧运镜刚好落位。
  assert.equal(timeline.camera.end, timeline.titleEndFrames);
});

test('没有开场白时运镜窗口为空：镜头从第 0 帧就停在取景上', () => {
  const timeline = buildTimeline(
    project({
      audioSegments: [
        {type: 'ranking', rank: 3, part: 'rank', duration: 0.5, gapAfter: 0},
        {type: 'ranking', rank: 3, part: 'name', duration: 1.5, gapAfter: 1},
      ],
    }),
  );
  assert.deepEqual(timeline.camera, {start: 0, end: 0});
});

test('无音频兜底路径：运镜填满静音片头，Studio 预览也能看到推进', () => {
  const timeline = buildTimeline(
    project({audioSegments: undefined, introDuration: 1.5, finalHoldDuration: 0}),
  );
  assert.equal(timeline.introFrames, 45);
  assert.deepEqual(timeline.camera, {start: 0, end: 45});
  assert.equal(timeline.camera.end, timeline.titleEndFrames);
});

test('同一份输入重复调用结果一致（缓存不改变语义）', () => {
  const input = project();
  const first = buildTimeline(input);
  const second = buildTimeline(input);
  assert.equal(first, second);
  assert.deepEqual(
    first.segments.map((segment) => segment.revealAt),
    second.segments.map((segment) => segment.revealAt),
  );
});
