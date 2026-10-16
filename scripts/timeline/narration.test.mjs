/**
 * 旁白拆分：点亮时刻的精度全靠它。
 *
 * 一条硬约束：拆分点必须**量在真实旁白文本里**（引擎实际念的那句），而不是
 * 按固定比例估——否则「名次念完、府名开口」的那一帧就会漂。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignScriptLines,
  buildRankingLine,
  buildRankingNarration,
  splitScriptLines,
  splitSpokenLine,
} from '../../src/timeline/narration.ts';

const roiEt = {rank: 3, provinceId: 'TH-45', provinceEn: 'Roi Et', provinceTh: 'ร้อยเอ็ด', value: 5600};

test('泰文真实文案：切在府名上，两段正好拼回整行', () => {
  const line = 'อันดับ 3 ร้อยเอ็ด (Roi Et) มีค่า 5,600';
  const parts = splitSpokenLine(line, roiEt);

  assert.deepEqual(parts, [
    {part: 'rank', text: 'อันดับ 3 '},
    {part: 'name', text: 'ร้อยเอ็ด (Roi Et) มีค่า 5,600'},
  ]);
  // 拼接等于原文：时间轴按字符长度分配时长，必须严格铺满整行。
  assert.equal(parts.map((part) => part.text).join(''), line);
  // 府名段以府名开头，所以它一开始念就是府被念到的瞬间。
  assert.ok(parts[1].text.startsWith('ร้อยเอ็ด'));
});

test('生成的英文模板行同样切在府名上', () => {
  const line = buildRankingLine(roiEt);
  assert.equal(line, 'Rank 3: ร้อยเอ็ด (Roi Et), 5,600');

  const parts = splitSpokenLine(line, roiEt);
  assert.deepEqual(parts, [
    {part: 'rank', text: 'Rank 3: '},
    {part: 'name', text: 'ร้อยเอ็ด (Roi Et), 5,600'},
  ]);
  assert.equal(parts.map((part) => part.text).join(''), line);
});

test('文案里没有府名：退到「名次数字之后」切，仍然铺满整行', () => {
  const parts = splitSpokenLine('อันดับ 3 จังหวัดชายแดนใต้', roiEt);
  assert.deepEqual(parts, [
    {part: 'rank', text: 'อันดับ 3 '},
    {part: 'name', text: 'จังหวัดชายแดนใต้'},
  ]);

  // 数字后面没有空格也认（泰文里名次和府名常常直接连着写）。
  const tight = splitSpokenLine('อันดับ 3ร้อยเอ็ด', {rank: 3, provinceEn: 'Roi Et'});
  assert.deepEqual(tight, [
    {part: 'rank', text: 'อันดับ 3'},
    {part: 'name', text: 'ร้อยเอ็ด'},
  ]);
  assert.equal(tight.map((part) => part.text).join(''), 'อันดับ 3ร้อยเอ็ด');
});

test('切不出两段的行返回 null（调用方保留整行，绝不造空段）', () => {
  assert.equal(splitSpokenLine('', roiEt), null);
  assert.equal(splitSpokenLine('   ', roiEt), null);
  assert.equal(splitSpokenLine('ร้อยเอ็ด', roiEt), null, '整行就是府名时切不出名次段');
  assert.equal(splitSpokenLine('อันดับ 3 ', roiEt), null, '名次后没有内容');
});

test('文案行拆分：按空行分块，数量对得上才采信真实文案', () => {
  const script = [
    'สวัสดีครับ',
    'อันดับ 3 ร้อยเอ็ด (Roi Et) มีค่า 5,600',
    'อันดับ 2 เชียงใหม่ (Chiang Mai) มีค่า 9,800',
    'อันดับ 1 กรุงเทพมหานคร (Bangkok) มีค่า 12,500',
  ].join('\n\n');

  assert.deepEqual(splitScriptLines(script), [
    'สวัสดีครับ',
    'อันดับ 3 ร้อยเอ็ด (Roi Et) มีค่า 5,600',
    'อันดับ 2 เชียงใหม่ (Chiang Mai) มีค่า 9,800',
    'อันดับ 1 กรุงเทพมหานคร (Bangkok) มีค่า 12,500',
  ]);
  assert.equal(alignScriptLines(script, 4)?.length, 4);
  // CRLF 与多余空行不影响。
  assert.equal(alignScriptLines(script.replace(/\n\n/g, '\r\n\r\n\r\n'), 4)?.length, 4);
  // 行数对不上（用户手改过文案）→ 整份忽略，退回生成的文案行。
  assert.equal(alignScriptLines(script, 5), null);
  assert.equal(alignScriptLines('', 1), null);
  assert.equal(alignScriptLines(undefined, 1), null);
});

test('buildRankingNarration：有真实行就用真实行，没有就用生成行，且永远两段非空', () => {
  const real = buildRankingNarration(roiEt, 'อันดับ 3 ร้อยเอ็ด (Roi Et) มีค่า 5,600');
  assert.equal(real.text, 'อันดับ 3 ร้อยเอ็ด (Roi Et) มีค่า 5,600');
  assert.deepEqual(real.parts.map((part) => part.part), ['rank', 'name']);

  const generated = buildRankingNarration(roiEt);
  assert.equal(generated.text, buildRankingLine(roiEt));
  assert.deepEqual(generated.parts, [
    {part: 'rank', text: 'Rank 3: '},
    {part: 'name', text: 'ร้อยเอ็ด (Roi Et), 5,600'},
  ]);

  // 拿到的行不可拆分（整行就是府名）→ 用生成行，而不是产出空段。
  const unusable = buildRankingNarration(roiEt, 'ร้อยเอ็ด');
  assert.equal(unusable.text, buildRankingLine(roiEt));
  assert.equal(unusable.parts.map((part) => part.text).join(''), unusable.text);

  // 所有情况下 parts 都必须铺满 text，时间轴才能按长度分配时长。
  [real, generated, unusable].forEach(({text, parts}) => {
    assert.equal(parts.map((part) => part.text).join(''), text);
    parts.forEach((part) => assert.ok(part.text.length > 0));
  });
});
