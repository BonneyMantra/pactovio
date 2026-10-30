import { z } from 'zod';
import { DocKind } from './common';

/** Output of pack.extractPack: the whole tender / RFP pack as text, page by page. */
export const PackText = z.object({
  docs: z.array(
    z.object({
      docId: z.string(),
      filename: z.string(),
      kind: DocKind,
      isForm: z.boolean(),
      pages: z.array(z.object({ n: z.number().int(), text: z.string() })),
      images: z.array(z.object({ page: z.number().int(), r2Key: z.string() })),
    }),
  ),
});
export type PackText = z.infer<typeof PackText>;

export const ExtractPackInput = z
  .object({
    tenderId: z.string().optional(),
    intakeId: z.string().optional(),
    r2Keys: z.array(z.string()),
  })
  .refine((v) => v.tenderId || v.intakeId, 'tenderId or intakeId required');
export type ExtractPackInput = z.infer<typeof ExtractPackInput>;
