import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  auditRankings,
  indexProvinceNames,
  listProvinces,
  lookupProvince,
  normalizeProvinceName,
  normalizeThaiName,
} from '../../src/data/provinceAudit.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const geojson = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'data', 'thailand-provinces.geo.json'), 'utf8'),
);

const row = (provinceId, provinceEn) => ({rank: 1, provinceId, provinceEn});

test('名称归一化：大小写、空格、连字符、Province 后缀与常见别名', () => {
  assert.equal(normalizeProvinceName('Chon Buri'), 'chonburi');
  assert.equal(normalizeProvinceName('chon-buri'), 'chonburi');
  assert.equal(normalizeProvinceName('  Chonburi Province '), 'chonburi');
  assert.equal(normalizeProvinceName('Changwat Chiang Mai'), 'chiangmai');
  assert.equal(normalizeProvinceName('Krung Thep Maha Nakhon'), 'bangkok');
  // 泰文没有可比对的拉丁字形 → 空串（调用方据此跳过而不是误报）
  assert.equal(normalizeProvinceName('กรุงเทพมหานคร'), '');
  assert.equal(normalizeProvinceName(undefined), '');
});

test('边界数据索引：77 个 id，名称与 id 一一对应', () => {
  const index = indexProvinceNames(geojson);
  assert.equal(index.size, 77);
  assert.equal(index.get('TH-10').name, 'Bangkok');
  assert.equal(index.get('TH-10').th, 'กรุงเทพมหานคร');
  assert.equal(index.get('TH-50').name, 'Chiang Mai');
  assert.equal(index.get('TH-96').name, 'Narathiwat');
  assert.equal(index.get('TH-45').name, 'Roi Et');
});

test('府列表：id 顺序，且三列（id / 英文名 / 泰文名）齐全', () => {
  const list = listProvinces(geojson);
  assert.equal(list.length, 77);
  assert.deepEqual(list[0], {
    id: 'TH-10',
    en: 'Bangkok',
    th: 'กรุงเทพมหานคร',
    enKey: 'bangkok',
    thKey: 'กรุงเทพมหานคร',
  });
  assert.deepEqual(list.at(-1).id, 'TH-96');
  assert.ok(list.every((item) => item.en && item.th), '泰文名不允许为空');
  assert.equal(new Set(list.map((item) => item.th)).size, 77, '泰文名不允许重复');
});

test('泰文名归一化：จังหวัด/จ. 前缀与空白被忽略', () => {
  assert.equal(normalizeThaiName('เชียงใหม่'), 'เชียงใหม่');
  assert.equal(normalizeThaiName(' จังหวัดเชียงใหม่ '), 'เชียงใหม่');
  assert.equal(normalizeThaiName('จ.เชียงใหม่'), 'เชียงใหม่');
  assert.equal(normalizeThaiName(undefined), '');
  // 泰文名不会被当成拉丁名来处理（两条规则互不干扰）
  assert.equal(normalizeProvinceName('เชียงใหม่'), '');
});

test('三向解析：府 ID / 英文名 / 泰文名都能定位到同一个府', () => {
  const id = (value) => lookupProvince(geojson, value).matches.map((m) => m.id);

  assert.deepEqual(id('TH-96'), ['TH-96']);
  assert.deepEqual(id('th-96'), ['TH-96']);
  assert.deepEqual(id('96'), ['TH-96']);
  assert.deepEqual(id('Narathiwat'), ['TH-96']);
  assert.deepEqual(id('nara-thiwat province'), ['TH-96']);
  assert.deepEqual(id('นราธิวาส'), ['TH-96']);
  assert.deepEqual(id('จังหวัดนราธิวาส'), ['TH-96']);

  // 英文别名的模糊匹配仍走同一条路（Ayutthaya → Phra Nakhon Si Ayutthaya）
  assert.deepEqual(id('Ayutthaya'), ['TH-14']);
  assert.deepEqual(id('Krung Thep'), ['TH-10']);

  // 找不到或不确定时必须给空/多结果，交给 UI 让用户选，绝不猜一个
  assert.deepEqual(id('Atlantis'), []);
  assert.deepEqual(id(''), []);
  assert.deepEqual(id('TH-999'), []);
  assert.ok(
    lookupProvince(geojson, 'Thani').matches.length > 1,
    'Pathum Thani / Uthai Thani / Surat Thani 不应该被猜成一个',
  );

  // 短泰文名只做全等匹配，避免 ตาก（来兴府）误配到其它名字里
  assert.deepEqual(id('ตาก'), ['TH-63']);
  assert.deepEqual(id('ก'), []);
});

test('解析结果带齐三列，UI 才能一次填满行', () => {
  const {matches} = lookupProvince(geojson, 'Chiang Mai');
  assert.deepEqual(matches, [
    {
      id: 'TH-50',
      en: 'Chiang Mai',
      th: 'เชียงใหม่',
      enKey: 'chiangmai',
      thKey: 'เชียงใหม่',
    },
  ]);
});

test('核心场景：id 与名称不符时必须报错并给出正确 id', () => {
  // 用户实际踩到的坑：那拉提瓦（最南部）被填成了 TH-45（东北的黎逸府）。
  const audit = auditRankings(geojson, [row('TH-45', 'Narathiwat')]);
  assert.equal(audit.mismatched.length, 1);
  assert.deepEqual(audit.mismatched[0], {
    provinceId: 'TH-45',
    givenName: 'Narathiwat',
    geoName: 'Roi Et',
    suggestedIds: ['TH-96'],
  });
  assert.equal(audit.unknownIds.length, 0);
  assert.ok(audit.warnings.some((w) => w.includes('TH-96')), audit.warnings.join('\n'));
});

test('反向场景：id 正确但名称写错同样被拦下', () => {
  const audit = auditRankings(geojson, [row('TH-96', 'Roi Et')]);
  assert.equal(audit.mismatched.length, 1);
  assert.equal(audit.mismatched[0].provinceId, 'TH-96');
  assert.equal(audit.mismatched[0].geoName, 'Narathiwat');
  assert.deepEqual(audit.mismatched[0].suggestedIds, ['TH-45']);
});

test('正确配对与常见拼写变体都不应误报', () => {
  const audit = auditRankings(geojson, [
    row('TH-10', 'Bangkok'),
    row('TH-50', 'Chiang Mai'),
    row('TH-20', 'Chonburi'),
    row('TH-14', 'Ayutthaya'),
    row('TH-31', 'Buri Ram'),
    row('TH-80', 'Nakhon Si Thammarat'),
    row('TH-83', 'Phuket'),
    row('TH-96', 'Narathiwat'),
  ]);
  assert.deepEqual(audit.mismatched, []);
  assert.deepEqual(audit.warnings, []);
  assert.equal(audit.checked, 8);

  // 同一 id 的两种写法不重复校验，但重复 id 本身仍然会被报出。
  const dup = auditRankings(geojson, [row('TH-31', 'Buriram'), row('TH-31', 'Buri Ram')]);
  assert.deepEqual(dup.mismatched, []);
  assert.deepEqual(dup.duplicateIds, ['TH-31']);
});

test('相似的府名不会被当成同一个：Nakhon Sawan ≠ Nakhon Si Thammarat', () => {
  const audit = auditRankings(geojson, [row('TH-60', 'Nakhon Si Thammarat')]);
  assert.equal(audit.mismatched.length, 1);
  assert.deepEqual(audit.mismatched[0].suggestedIds, ['TH-80']);
  assert.equal(audit.checked, 1);
});

test('泰文名或空名没有可比信息，跳过而不是误报', () => {
  const thaiOnly = auditRankings(geojson, [
    {rank: 1, provinceId: 'TH-45', provinceEn: 'นราธิวาส'},
  ]);
  assert.deepEqual(thaiOnly.mismatched, []);
  assert.equal(thaiOnly.checked, 0);
  assert.deepEqual(thaiOnly.warnings, []);

  const empty = auditRankings(geojson, [row('TH-45', '   ')]);
  assert.deepEqual(empty.mismatched, []);
  assert.deepEqual(empty.warnings, []);
});

test('异常输入：未知 id、重复 id、空数据、缺字段', () => {
  const audit = auditRankings(geojson, [
    row('TH-999', 'Nowhere'),
    row('th-10', 'Bangkok'),
    row('TH-10', 'Bangkok'),
    {rank: 4, provinceEn: 'Bangkok'},
    null,
  ]);
  assert.deepEqual(audit.unknownIds, ['TH-999']);
  assert.deepEqual(audit.duplicateIds, ['TH-10']);
  assert.deepEqual(audit.mismatched, []);
  assert.ok(audit.warnings.some((w) => w.includes('TH-999')));
  assert.ok(audit.warnings.some((w) => w.includes('重复')));

  assert.deepEqual(auditRankings(geojson, []).warnings, []);
  assert.deepEqual(auditRankings(geojson, null).warnings, []);
  assert.deepEqual(auditRankings(geojson, undefined).warnings, []);
  assert.deepEqual(auditRankings({features: []}, [row('TH-10', 'Bangkok')]).unknownIds, [
    'TH-10',
  ]);
  // 非法几何/无属性的边界数据不应抛异常。
  assert.equal(auditRankings({features: [null, {properties: null}]}, []).total, 0);
});

test('确定性与幂等：同一输入重复调用结果一致（且不受调用顺序影响）', () => {
  const rows = [row('TH-45', 'Narathiwat'), row('TH-10', 'Bangkok')];
  const first = auditRankings(geojson, rows);
  const second = auditRankings(geojson, rows);
  assert.deepEqual(first, second);
  assert.equal(first.warnings.length, 1);
});
