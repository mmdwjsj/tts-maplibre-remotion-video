/**
 * Replaces the province geometry in `src/data/thailand-provinces.geo.json` with
 * a high-resolution boundary set, keeping every existing attribute untouched.
 *
 * Why: the shipped file had 77 provinces in ~1,500 points total (median segment
 * ~20px once projected to 1080px wide), so every coastline and every shared
 * border read as a straight ruler line. At 1080x1920 the fix is geometry, not
 * rendering: GADM's admin-1 set carries ~54,000 points (median segment 0.66px),
 * i.e. sub-pixel at full-country framing and still smooth when the camera zooms
 * into a handful of provinces.
 *
 * Ids are matched on GADM's `ISO_1` (`TH-37`) which is exactly the `provinceId`
 * the renderer keys on, so `provinceEn` / `provinceTh` are copied from the old
 * file instead of being re-derived from GADM names (`BangkokMetropolis`,
 * `ChonBuri`, …) — that keeps the name audit and the 泰文名 columns byte-identical.
 *
 * Usage:
 *   node scripts/data/import-province-boundaries.mjs <path-to-gadm41_THA_1.json>
 *
 * Source: https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_THA_1.json
 * (GADM 4.1, admin level 1). GADM is free for academic/non-commercial use.
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {geoArea} from 'd3-geo';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEO_PATH = resolve(ROOT, 'src', 'data', 'thailand-provinces.geo.json');

const source = process.argv[2];
if (!source) {
  console.error('用法：node scripts/data/import-province-boundaries.mjs <gadm41_THA_1.json>');
  process.exit(1);
}

/** Thailand's land area, for the sanity check below (km²). */
const THAILAND_AREA_KM2 = 513120;
/** Mean earth radius used by d3-geo, in km. */
const EARTH_RADIUS_KM = 6371.0088;
const STERADIAN_KM2 = EARTH_RADIUS_KM * EARTH_RADIUS_KM;
/** 6 decimals ≈ 11cm — far below one pixel, and it strips GADM's 14-16 digit noise. */
const PRECISION = 6;

const round = (value) => {
  const factor = 10 ** PRECISION;
  return Math.round(value * factor) / factor;
};

const ringsOf = (geometry) => {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  throw new Error(`不支持的几何类型：${geometry.type}`);
};

/**
 * GADM ships a trailing vertex identical to the first one. `d3-geo` accepts
 * either, but keeping the ring explicitly closed matches the previous file and
 * keeps `path.bounds` / `path.centroid` behaviour unchanged.
 */
const cleanRing = (ring) => {
  const points = ring.map(([lon, lat]) => [round(lon), round(lat)]);
  const deduped = points.filter(
    (point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1],
  );
  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  if (!first || !last) return null;
  if (first[0] !== last[0] || first[1] !== last[1]) deduped.push([first[0], first[1]]);
  // A ring needs 3 distinct vertices plus the closing one to enclose any area.
  return deduped.length >= 4 ? deduped : null;
};

const cleanGeometry = (geometry, label) => {
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates.map(cleanRing).filter(Boolean);
    if (!rings.length) throw new Error(`${label}：多边形清洗后为空`);
    return {type: 'Polygon', coordinates: rings};
  }
  const polygons = geometry.coordinates
    .map((polygon) => polygon.map(cleanRing).filter(Boolean))
    .filter((polygon) => polygon.length > 0);
  if (!polygons.length) throw new Error(`${label}：多多边形清洗后为空`);
  return {type: 'MultiPolygon', coordinates: polygons};
};

const countPoints = (geometry) =>
  ringsOf(geometry).reduce((sum, ring) => sum + ring.length, 0);

const oldGeo = JSON.parse(readFileSync(GEO_PATH, 'utf8'));
const gadm = JSON.parse(readFileSync(source, 'utf8'));

/** provinceId → {provinceEn, provinceTh}, and the original feature order. */
const attributes = new Map();
for (const feature of oldGeo.features) {
  const id = String(feature.properties?.provinceId ?? '').trim().toUpperCase();
  if (!id) throw new Error('旧文件存在缺少 provinceId 的要素');
  attributes.set(id, {
    provinceEn: String(feature.properties?.provinceEn ?? '').trim(),
    provinceTh: String(feature.properties?.provinceTh ?? '').trim(),
  });
}

/**
 * GADM stores the ISO 3166-2 code in `ISO_1` (`TH-37`), except for Bangkok
 * where it is literally `NA` — its numeric code in `CC_1` (`10`) is the only
 * usable key there, so that is the fallback.
 */
const isoIdOf = (properties) => {
  const iso = String(properties?.ISO_1 ?? '').trim().toUpperCase();
  if (/^TH-\d{1,2}$/u.test(iso)) return iso;
  const numeric = String(properties?.CC_1 ?? '').trim();
  if (/^\d{1,2}$/u.test(numeric)) return `TH-${numeric}`;
  return '';
};

const byIso = new Map();
for (const feature of gadm.features) {
  const iso = isoIdOf(feature.properties);
  if (!iso) throw new Error(`GADM 要素无法定位到府编码：${feature.properties?.NAME_1}`);
  if (byIso.has(iso)) throw new Error(`GADM 中府编码重复：${iso}`);
  byIso.set(iso, feature);
}

const missing = [...attributes.keys()].filter((id) => !byIso.has(id));
const extra = [...byIso.keys()].filter((id) => !attributes.has(id));
if (missing.length || extra.length) {
  console.error(`GADM 缺少这些府：${missing.join('、') || '无'}`);
  console.error(`GADM 多出这些府：${extra.join('、') || '无'}`);
  process.exit(1);
}

let oldPoints = 0;
let newPoints = 0;
const features = [];
const areaById = new Map();

for (const [id, prop] of attributes) {
  const gadmFeature = byIso.get(id);
  if (!prop.provinceEn || !prop.provinceTh) throw new Error(`${id}：旧属性缺英文名或泰文名`);
  const geometry = cleanGeometry(gadmFeature.geometry, id);
  const areaKm2 = geoArea(geometry) * STERADIAN_KM2;
  // Ring winding decides whether d3 fills the province or the rest of the planet.
  if (!(areaKm2 > 1)) {
    throw new Error(
      `${id} (${prop.provinceEn}) 球面面积为 ${areaKm2.toFixed(1)} km²，` +
        '环方向可能反了（d3-geo 会填充整个地球）',
    );
  }
  areaById.set(id, areaKm2);
  newPoints += countPoints(geometry);
  features.push({
    type: 'Feature',
    properties: {provinceId: id, provinceEn: prop.provinceEn, provinceTh: prop.provinceTh},
    geometry,
  });
}

for (const feature of oldGeo.features) oldPoints += countPoints(feature.geometry);

const totalArea = [...areaById.values()].reduce((sum, value) => sum + value, 0);
const drift = Math.abs(totalArea - THAILAND_AREA_KM2) / THAILAND_AREA_KM2;
if (drift > 0.05) {
  throw new Error(
    `总面积 ${Math.round(totalArea)} km² 与泰国陆地面积 ${THAILAND_AREA_KM2} km² 相差 ${(drift * 100).toFixed(1)}%，几何可疑`,
  );
}

const out = {type: 'FeatureCollection', features};
// Minified like the file it replaces: this module is imported into the bundle,
// formatting would only add bytes.
writeFileSync(GEO_PATH, `${JSON.stringify(out)}\n`, 'utf8');

const largest = [...areaById.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
const smallest = [...areaById.entries()].sort((a, b) => a[1] - b[1]).slice(0, 3);
console.log(`已写入 ${GEO_PATH}`);
console.log(`  要素 ${features.length} 个 · 点数 ${oldPoints} → ${newPoints}（×${(newPoints / oldPoints).toFixed(1)}）`);
console.log(`  总面积 ${Math.round(totalArea).toLocaleString('en-US')} km²（与参考值相差 ${(drift * 100).toFixed(1)}%）`);
console.log(`  最大三府：${largest.map(([id, km2]) => `${id} ${Math.round(km2)}`).join('，')}`);
console.log(`  最小三府：${smallest.map(([id, km2]) => `${id} ${km2.toFixed(1)}`).join('，')}`);
