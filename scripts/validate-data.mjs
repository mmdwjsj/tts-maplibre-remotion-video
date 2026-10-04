import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const file = resolve(process.argv[2] ?? 'public/data/rankings.json');
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
console.log(`Valid: ${rows.length} ranking rows (${rows[0].provinceId} ... ${rows.at(-1).provinceId})`);
