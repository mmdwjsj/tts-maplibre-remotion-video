// The `.ts` extension is deliberate: it keeps this module loadable straight from
// Node (type stripping) so the web server and `scripts/timeline/*.test.mjs`
// share exactly one implementation — the same rule `provinceAudit.ts` and
// `buildTimeline.ts` follow.

/**
 * Turning the ranking table into the narration the engine actually speaks, and
 * locating the boundaries *inside* that narration.
 *
 * This is what the timeline is split on: the boundary between the rank
 * announcement and the province name is measured in the real spoken line (the
 * text the synthesizer is handed), not estimated from a share of the line. The
 * highlight therefore lands exactly where the voice reaches the province name.
 */

export type NarrationPart = { part: "rank" | "name"; text: string };

export type NarrationRanking = {
  rank: number;
  provinceEn?: string;
  provinceTh?: string;
  value?: number;
};

/** `provinceTh` is what the Thai voice reads; `provinceEn` is the fallback. */
const provinceName = (ranking: NarrationRanking) =>
  String(ranking.provinceTh || ranking.provinceEn || "").trim();

/**
 * The line the server writes when the script gives us nothing usable. Kept
 * byte-identical to the historical template so a fallback render still slices
 * the audio the same way it always did.
 */
export const buildRankingLine = (ranking: NarrationRanking): string =>
  `Rank ${ranking.rank}: ${ranking.provinceTh || ranking.provinceEn} (${ranking.provinceEn}), ${Number(
    ranking.value,
  ).toLocaleString()}`;

/**
 * Splits one spoken line into the rank announcement and the province itself.
 *
 * The cut is placed on the province name inside `line`. When the line does not
 * contain the name at all (a hand-written line), it falls back to cutting right
 * after the rank number, so the two pieces still tile the line exactly — which
 * is what keeps the character-proportional timing honest. Returns `null` only
 * when the line cannot be split sensibly; the caller then keeps it whole.
 */
export const splitSpokenLine = (
  line: unknown,
  ranking: NarrationRanking,
): NarrationPart[] | null => {
  const text = String(line ?? "");
  if (!text.trim()) return null;

  const name = provinceName(ranking);
  const nameAt = name ? text.indexOf(name) : -1;
  if (nameAt > 0) {
    return [
      { part: "rank", text: text.slice(0, nameAt) },
      { part: "name", text: text.slice(nameAt) },
    ];
  }

  // No province name to cut on: cut after the rank number instead ("อันดับ 3 " /
  // "Rank 3: "), keeping any whitespace with the announcement.
  const rankMatch = /\d+/.exec(text);
  if (!rankMatch) return null;
  const afterRank = rankMatch.index + rankMatch[0].length;
  const padding = /^\s*/.exec(text.slice(afterRank))?.[0].length ?? 0;
  const cut = afterRank + padding;

  return cut > 0 && cut < text.length
    ? [
        { part: "rank", text: text.slice(0, cut) },
        { part: "name", text: text.slice(cut) },
      ]
    : null;
};

/**
 * Splits the narration textarea into the lines the engine will speak. The UI
 * joins them with a blank line, so that is the separator.
 */
export const splitScriptLines = (script: unknown): string[] =>
  String(script ?? "")
    .split(/\r?\n\s*\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The script is the ground truth for the timeline — but only while it still
 * lines up with the ranking table. A hand-edited script with a different number
 * of blocks would desync every single highlight, so it is ignored (and the
 * generated lines are used instead) unless the count matches exactly.
 */
export const alignScriptLines = (
  script: unknown,
  expected: number,
): string[] | null => {
  const lines = splitScriptLines(script);
  return lines.length === expected ? lines : null;
};

/**
 * Builds one ranking item: the line as it will be spoken, plus the two pieces it
 * is spoken in. `spokenLine` is the real line from the script (see
 * `alignScriptLines`); when it is missing or cannot be split, the generated line
 * and its split are used instead, so the timeline always gets two non-empty
 * pieces.
 */
export const buildRankingNarration = (
  ranking: NarrationRanking,
  spokenLine?: string,
): { text: string; parts: NarrationPart[] } => {
  const fallback = buildRankingLine(ranking);
  const generated: NarrationPart[] = [
    { part: "rank", text: `Rank ${ranking.rank}: ` },
    { part: "name", text: fallback.slice(`Rank ${ranking.rank}: `.length) },
  ];
  const line = String(spokenLine ?? "").trim();
  const parts = line ? splitSpokenLine(line, ranking) : null;

  return parts && parts.every((part) => part.text.length > 0)
    ? { text: line, parts }
    : { text: fallback, parts: generated };
};
