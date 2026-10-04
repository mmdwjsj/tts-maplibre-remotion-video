import * as XLSX from 'xlsx';
import {rankingsSchema} from './schema';
import type {RankingDatum} from '../types';

export const parseJsonRankings = (input: unknown): RankingDatum[] =>
  rankingsSchema.parse(input).sort((a, b) => a.rank - b.rank);

export const parseExcelRankings = (buffer: ArrayBuffer): RankingDatum[] => {
  const workbook = XLSX.read(buffer, {type: 'array'});
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) throw new Error('Excel workbook has no sheets');
  return parseJsonRankings(XLSX.utils.sheet_to_json(firstSheet));
};
