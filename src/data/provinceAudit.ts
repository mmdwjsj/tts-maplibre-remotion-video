/**
 * Guards the one failure mode the stable-id contract cannot catch by itself: a
 * ranking row whose `provinceId` points at province A while its `provinceEn`
 * label names province B.
 *
 * The renderer keys everything off `provinceId` (that is deliberate — names are
 * unreliable), so such a row lights up A while the floating label reads B. The
 * result looks like a map bug even though the map is right. This module finds
 * those rows before rendering, and reverse-looks-up the id the name implies.
 *
 * Pure and dependency free, so the web server, the CLI and the tests share
 * exactly one implementation.
 *
 * It also owns the id ↔ 英文名 ↔ 泰文名 mapping: `listProvinces` feeds the form's
 * pickers and `lookupProvince` reverse-resolves whatever the user typed, so all
 * three columns of a ranking row can be derived from any one of them.
 */

export type ProvinceAuditGeoJson = {
  features?:
    | Array<
        {
          properties?: {
            provinceId?: unknown;
            provinceEn?: unknown;
            provinceTh?: unknown;
          } | null;
        } | null
      >
    | null;
};

/** Only the fields this check reads, so any ranking shape can be passed in. */
export type ProvinceAuditRow = {
  rank?: number;
  provinceId?: unknown;
  provinceEn?: unknown;
};

export type ProvinceNameMismatch = {
  provinceId: string;
  /** The latin name the row claims to be. */
  givenName: string;
  /** The real province that `provinceId` resolves to. */
  geoName: string;
  /** Ids whose real province name matches `givenName` (what the row probably meant). */
  suggestedIds: string[];
};

export type ProvinceAudit = {
  total: number;
  /** Rows that had both a known id and a latin name to compare. */
  checked: number;
  unknownIds: string[];
  duplicateIds: string[];
  mismatched: ProvinceNameMismatch[];
  warnings: string[];
};

/**
 * Spellings the plain normalisation cannot bridge. Keep this list tiny: the
 * normaliser already collapses spaces, hyphens, dots and case, so only genuine
 * aliases belong here.
 */
const NAME_ALIASES: Record<string, string> = {
  krungthep: 'bangkok',
  krungthepmahanakhon: 'bangkok',
  bangkokmetropolis: 'bangkok',
};

/** `Chonburi` / `chon-buri` / `Chon Buri Province` → `chonburi`. */
export const normalizeProvinceName = (value: unknown): string => {
  const letters = String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z]/g, '');
  if (!letters) return '';
  const trimmed = letters.replace(/^changwat/, '').replace(/province$/, '');
  return NAME_ALIASES[trimmed] ?? trimmed;
};

/**
 * `Ayutthaya` should still match `Phra Nakhon Si Ayutthaya`, and `Nakhon Si
 * Thammarat` must not match `Nakhon Sawan`. A suffix test on reasonably long
 * names does exactly that.
 */
const sameName = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && (a.endsWith(b) || b.endsWith(a));
};

/**
 * `จังหวัดเชียงใหม่` / `จ.เชียงใหม่` / `เชียงใหม่ ` → `เชียงใหม่`. Thai is not
 * case-folded and has no meaningful word separators, so this only strips the
 * "province" prefix, zero-width characters and whitespace.
 */
export const normalizeThaiName = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFC')
    .replace(/[\s\u200b-\u200d\ufeff]+/gu, '')
    .replace(/^(จังหวัด|จ\.)/u, '');

export type ProvinceIndexEntry = {
  id: string;
  name: string;
  key: string;
  th: string;
  thKey: string;
};

/** `provinceId → {id, name, key, th, thKey}` from the boundary data (first wins). */
export const indexProvinceNames = (
  geojson: ProvinceAuditGeoJson,
): Map<string, ProvinceIndexEntry> => {
  const byId = new Map<string, ProvinceIndexEntry>();
  for (const feature of geojson?.features ?? []) {
    const id = String(feature?.properties?.provinceId ?? '')
      .trim()
      .toUpperCase();
    if (!id || byId.has(id)) continue;
    const name = String(feature?.properties?.provinceEn ?? '').trim();
    const th = String(feature?.properties?.provinceTh ?? '').trim();
    byId.set(id, {
      id,
      name,
      key: normalizeProvinceName(name),
      th,
      thKey: normalizeThaiName(th),
    });
  }
  return byId;
};

/**
 * Everything one row needs to describe a province. `enKey` / `thKey` travel with
 * the list so the browser can do exact matching without re-implementing the
 * normalisation rules; anything fuzzier goes through `lookupProvince`.
 */
export type ProvinceOption = {
  id: string;
  en: string;
  th: string;
  enKey: string;
  thKey: string;
};

/**
 * Every province in `id` order — the picker order for a 府 ID dropdown, and the
 * candidate source for the name columns.
 */
export const listProvinces = (geojson: ProvinceAuditGeoJson): ProvinceOption[] =>
  [...indexProvinceNames(geojson).values()]
    .map(({id, name, key, th, thKey}) => ({
      id,
      en: name,
      th,
      enKey: key,
      thKey,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

export type ProvinceLookup = {
  /** The raw text that was looked up, echoed back for the caller's messages. */
  query: string;
  /** Every province the query could mean, in list order. */
  matches: ProvinceOption[];
};

/**
 * Turns whatever a human typed into province candidates: the id (`TH-96`, `th96`
 * or a bare `96`), the latin name (any spelling the normaliser accepts) or the
 * Thai name (with or without `จังหวัด`).
 *
 * Returning *all* matches instead of the first one is deliberate: ambiguous
 * input (`Nakhon`, or two provinces ending in the same word) must not silently
 * pick a province, it must fall back to a chooser or to the id.
 *
 * Used by the web server and the CLI, so the browser never has to guess.
 */
export const lookupProvince = (
  geojson: ProvinceAuditGeoJson,
  value: unknown,
): ProvinceLookup => {
  const query = String(value ?? '').trim();
  const options = listProvinces(geojson);
  if (!query) return {query, matches: []};

  const digits = query.replace(/^th-?/iu, '').trim();
  if (/^\d{1,2}$/u.test(digits)) {
    const id = `TH-${digits}`;
    return {query, matches: options.filter((option) => option.id === id)};
  }

  const thaiKey = normalizeThaiName(query);
  if (/[\u0e00-\u0e7f]/u.test(thaiKey)) {
    const exact = options.filter((option) => option.thKey === thaiKey);
    if (exact.length) return {query, matches: exact};
    // Thai names are long enough that a suffix test is safe; short ones (`เลย`,
    // `ตาก`) only ever match exactly.
    return {
      query,
      matches:
        thaiKey.length >= 6
          ? options.filter(
              (option) =>
                option.thKey.length >= 6 &&
                (option.thKey.endsWith(thaiKey) || thaiKey.endsWith(option.thKey)),
            )
          : [],
    };
  }

  const key = normalizeProvinceName(query);
  if (!key) return {query, matches: []};
  const exact = options.filter((option) => option.enKey === key);
  return {
    query,
    matches: exact.length
      ? exact
      : options.filter((option) => sameName(key, option.enKey)),
  };
};

export const auditRankings = (
  geojson: ProvinceAuditGeoJson,
  rankings: ProvinceAuditRow[] | null | undefined,
): ProvinceAudit => {
  const index = indexProvinceNames(geojson);
  const rows = Array.isArray(rankings) ? rankings : [];
  const seen = new Set<string>();
  const unknownIds: string[] = [];
  const duplicateIds: string[] = [];
  const mismatched: ProvinceNameMismatch[] = [];
  let checked = 0;

  rows.forEach((row) => {
    const id = String(row?.provinceId ?? '')
      .trim()
      .toUpperCase();
    if (!id) return;
    if (seen.has(id)) {
      duplicateIds.push(id);
      return;
    }
    seen.add(id);

    const entry = index.get(id);
    if (!entry) {
      unknownIds.push(id);
      return;
    }

    // A Thai-only or empty latin name carries no comparable information; the
    // Thai script cannot be normalised to ascii, so it is skipped rather than
    // reported as a mismatch.
    const givenName = String(row?.provinceEn ?? '').trim();
    const givenKey = normalizeProvinceName(givenName);
    if (!givenKey) return;

    checked += 1;
    if (sameName(givenKey, entry.key)) return;

    const suggestedIds = [...index.values()]
      .filter((candidate) => sameName(givenKey, candidate.key))
      .map((candidate) => candidate.id);

    mismatched.push({provinceId: id, givenName, geoName: entry.name, suggestedIds});
  });

  const warnings: string[] = [];
  if (unknownIds.length) {
    warnings.push(
      `以下 provinceId 在行政区域数据中不存在，地图不会高亮它们：${unknownIds.join('、')}`,
    );
  }
  if (duplicateIds.length) {
    warnings.push(
      `以下 provinceId 重复出现，只按第一条取景与播报：${[...new Set(duplicateIds)].join('、')}`,
    );
  }
  mismatched.forEach((item) => {
    warnings.push(
      `id 与名称不符：${item.provinceId} 在行政区域数据中是「${item.geoName}」，` +
        `但这一行填的名称是「${item.givenName}」；地图会按 id 高亮 ${item.geoName}。` +
        (item.suggestedIds.length
          ? `应为 ${item.suggestedIds.join(' 或 ')}。`
          : '未找到与该名称匹配的行政区域，请核对拼写，或查一次 id 对照表。'),
    );
  });

  return {
    total: rows.length,
    checked,
    unknownIds,
    duplicateIds,
    mismatched,
    warnings,
  };
};

/** True when the audit found something the user must know about. */
export const hasProvinceProblems = (audit: ProvinceAudit): boolean =>
  audit.warnings.length > 0;
