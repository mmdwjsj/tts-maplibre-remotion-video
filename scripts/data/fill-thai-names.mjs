/**
 * Backfills the Thai name of every province in the boundary file.
 *
 * The boundary file ships `provinceTh` on every feature but leaves it empty,
 * which is why the form could not fill the 泰文名 column from a 府 ID. The table
 * below is the ISO 3166-2:TH roster (77 ids, `TH-<province code>`), keyed by the
 * same ids the map highlights on.
 *
 * The file is minified and ~70 KB of coordinates, so this rewrites the text in
 * place instead of re-serialising the JSON — formatting and the exact numbers
 * stay untouched. Idempotent: running it twice writes the same file.
 *
 *   node scripts/data/fill-thai-names.mjs
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEO_PATH = resolve(ROOT, 'src', 'data', 'thailand-provinces.geo.json');

/** provinceId → Thai name (จังหวัด… spelled out is not part of the name). */
const THAI_NAMES = {
  'TH-10': 'กรุงเทพมหานคร',
  'TH-11': 'สมุทรปราการ',
  'TH-12': 'นนทบุรี',
  'TH-13': 'ปทุมธานี',
  'TH-14': 'พระนครศรีอยุธยา',
  'TH-15': 'อ่างทอง',
  'TH-16': 'ลพบุรี',
  'TH-17': 'สิงห์บุรี',
  'TH-18': 'ชัยนาท',
  'TH-19': 'สระบุรี',
  'TH-20': 'ชลบุรี',
  'TH-21': 'ระยอง',
  'TH-22': 'จันทบุรี',
  'TH-23': 'ตราด',
  'TH-24': 'ฉะเชิงเทรา',
  'TH-25': 'ปราจีนบุรี',
  'TH-26': 'นครนายก',
  'TH-27': 'สระแก้ว',
  'TH-30': 'นครราชสีมา',
  'TH-31': 'บุรีรัมย์',
  'TH-32': 'สุรินทร์',
  'TH-33': 'ศรีสะเกษ',
  'TH-34': 'อุบลราชธานี',
  'TH-35': 'ยโสธร',
  'TH-36': 'ชัยภูมิ',
  'TH-37': 'อำนาจเจริญ',
  'TH-38': 'บึงกาฬ',
  'TH-39': 'หนองบัวลำภู',
  'TH-40': 'ขอนแก่น',
  'TH-41': 'อุดรธานี',
  'TH-42': 'เลย',
  'TH-43': 'หนองคาย',
  'TH-44': 'มหาสารคาม',
  'TH-45': 'ร้อยเอ็ด',
  'TH-46': 'กาฬสินธุ์',
  'TH-47': 'สกลนคร',
  'TH-48': 'นครพนม',
  'TH-49': 'มุกดาหาร',
  'TH-50': 'เชียงใหม่',
  'TH-51': 'ลำพูน',
  'TH-52': 'ลำปาง',
  'TH-53': 'อุตรดิตถ์',
  'TH-54': 'แพร่',
  'TH-55': 'น่าน',
  'TH-56': 'พะเยา',
  'TH-57': 'เชียงราย',
  'TH-58': 'แม่ฮ่องสอน',
  'TH-60': 'นครสวรรค์',
  'TH-61': 'อุทัยธานี',
  'TH-62': 'กำแพงเพชร',
  'TH-63': 'ตาก',
  'TH-64': 'สุโขทัย',
  'TH-65': 'พิษณุโลก',
  'TH-66': 'พิจิตร',
  'TH-67': 'เพชรบูรณ์',
  'TH-70': 'ราชบุรี',
  'TH-71': 'กาญจนบุรี',
  'TH-72': 'สุพรรณบุรี',
  'TH-73': 'นครปฐม',
  'TH-74': 'สมุทรสาคร',
  'TH-75': 'สมุทรสงคราม',
  'TH-76': 'เพชรบุรี',
  'TH-77': 'ประจวบคีรีขันธ์',
  'TH-80': 'นครศรีธรรมราช',
  'TH-81': 'กระบี่',
  'TH-82': 'พังงา',
  'TH-83': 'ภูเก็ต',
  'TH-84': 'สุราษฎร์ธานี',
  'TH-85': 'ระนอง',
  'TH-86': 'ชุมพร',
  'TH-90': 'สงขลา',
  'TH-91': 'สตูล',
  'TH-92': 'ตรัง',
  'TH-93': 'พัทลุง',
  'TH-94': 'ปัตตานี',
  'TH-95': 'ยะลา',
  'TH-96': 'นราธิวาส',
};

const source = readFileSync(GEO_PATH, 'utf8');
const geojson = JSON.parse(source);
const ids = geojson.features.map((feature) => feature.properties.provinceId);

const missing = ids.filter((id) => !THAI_NAMES[id]);
const extra = Object.keys(THAI_NAMES).filter((id) => !ids.includes(id));
if (missing.length || extra.length) {
  throw new Error(
    `泰文名表与边界数据不一致：缺少 ${missing.join('、') || '无'}；多余 ${extra.join('、') || '无'}`,
  );
}

let filled = 0;
let output = source;
// Only the `"provinceTh":""` that follows the matching `provinceId` is touched,
// so no coordinate can be altered by this rewrite.
for (const id of ids) {
  const pattern = new RegExp(
    `("provinceId":"${id}","provinceEn":"[^"]*","provinceTh":")(")`,
  );
  if (!pattern.test(output)) {
    throw new Error(`${id} 在边界文件里不是 provinceId/provinceEn/provinceTh 的排列，已中止`);
  }
  output = output.replace(pattern, `$1${THAI_NAMES[id]}$2`);
  filled += 1;
}

writeFileSync(GEO_PATH, output, 'utf8');

const written = JSON.parse(readFileSync(GEO_PATH, 'utf8'));
const stillEmpty = written.features.filter((f) => !f.properties.provinceTh);
const jsonEqual =
  JSON.stringify(written.features.map((f) => f.geometry)) ===
  JSON.stringify(geojson.features.map((f) => f.geometry));

console.log(`已写入 ${filled} 个泰文名；仍为空的 provinceTh：${stillEmpty.length}`);
console.log(`几何数据未被改动：${jsonEqual ? '是' : '否'}`);
