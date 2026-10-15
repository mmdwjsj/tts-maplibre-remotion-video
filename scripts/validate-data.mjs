import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {auditRankings} from '../src/data/provinceAudit.ts';

const args = process.argv.slice(2);
const strict = args.includes('--strict-naming');
const file = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'public/data/rankings.json');

const rows = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(rows) || rows.length === 0) throw new Error('Ranking data must be a non-empty array');
const ranks = new Set();
const ids = new Set();
for (const [index, row] of rows.entries()) {
  for (const key of ['rank', 'provinceId', 'provinceEn', 'provinceTh', 'value']) {
    if (row[key] === undefined || row[key] === '') throw new Error(`Row ${index + 1}: missing ${key}`);
  }
  if (ranks.has(row.rank)) throw new Error(`Duplicate rank ${row.rank}`);
  if (ids.has(row.provinceId)) throw new Error(`Duplicate provinceId ${row.provinceId}`);
  ranks.add(row.rank); ids.add(row.provinceId);
}

/**
 * `provinceId` is the stable key the map highlights on, so a row whose name
 * disagrees with its id renders the wrong shape. Reported here (and turned into
 * a failure by --strict-naming) instead of silently shipping.
 */
const geojson = JSON.parse(readFileSync(resolve('src/data/thailand-provinces.geo.json'), 'utf8'));
const audit = auditRankings(geojson, rows);
if (audit.warnings.length) {
  console.error(`\n数据警告（${audit.warnings.length} 条）：`);
  audit.warnings.forEach((line) => console.error(`  ! ${line}`));
  if (strict) {
    console.error('\n--strict-naming：存在 provinceId 与名称不一致，判定为失败。');
    process.exit(1);
  }
}

console.log(
  audit.warnings.length
    ? `Valid: ${rows.length} ranking rows (${rows[0].provinceId} ... ${rows.at(-1).provinceId})` +
        ` · 校验 ${audit.checked}/${audit.total} 行，有 ${audit.warnings.length} 条警告`
    : `Valid: ${rows.length} ranking rows (${rows[0].provinceId} ... ${rows.at(-1).provinceId})` +
        ` · provinceId 与府名一致 ${audit.checked}/${audit.total}`,
);
