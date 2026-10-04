import {z} from 'zod';

export const rankingSchema = z.object({
  rank: z.coerce.number().int().positive(),
  provinceId: z.string().min(1),
  province: z.string().optional(),
  provinceEn: z.string().min(1),
  provinceTh: z.string().min(1),
  value: z.coerce.number(),
  valueLabel: z.string().optional(),
  narrationDuration: z.coerce.number().positive().optional(),
});

export const rankingsSchema = z.array(rankingSchema).min(1).superRefine((rows, ctx) => {
  const ranks = new Set<number>();
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (ranks.has(row.rank)) ctx.addIssue({code: 'custom', message: `Duplicate rank ${row.rank}`, path: [index, 'rank']});
    if (ids.has(row.provinceId)) ctx.addIssue({code: 'custom', message: `Duplicate provinceId ${row.provinceId}`, path: [index, 'provinceId']});
    ranks.add(row.rank);
    ids.add(row.provinceId);
  });
});
