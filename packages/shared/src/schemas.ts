import { z } from 'zod';

export const MAX_PINS_PER_IMPORT = 2_000;
export const MAX_FIELD_LENGTH = 10_000;

const nullableText = z.string().trim().max(MAX_FIELD_LENGTH).nullable().optional();
const httpUrl = z.string().trim().url().refine((value) => /^https?:\/\//i.test(value), 'URL must use http or https');

export const imageVariantSchema = z.object({
  url: httpUrl,
  width: z.number().int().positive().max(20_000).nullable().optional(),
  height: z.number().int().positive().max(20_000).nullable().optional()
}).strict();

export const boardSchema = z.object({
  externalId: z.string().trim().max(500).nullable().optional(),
  name: z.string().trim().min(1).max(500),
  url: httpUrl,
  description: nullableText
}).strict();

export const pinSchema = z.object({
  externalId: z.string().trim().max(500).nullable().optional(),
  pinUrl: httpUrl.nullable().optional(),
  imageUrl: httpUrl,
  previewUrl: httpUrl.nullable().optional(),
  imageVariants: z.array(imageVariantSchema).max(20).optional(),
  title: nullableText,
  description: nullableText,
  altText: nullableText,
  sourceLink: httpUrl.nullable().optional(),
  width: z.number().int().positive().max(20_000).nullable().optional(),
  height: z.number().int().positive().max(20_000).nullable().optional()
}).strict().superRefine((pin, context) => {
  if (!pin.externalId && !pin.pinUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Pin requires externalId or pinUrl' });
  }
});

export const envelopeShapeSchema = z.object({
  schemaVersion: z.number().int(),
  source: z.string().trim().min(1).max(200),
  exportedAt: z.string().datetime({ offset: true }),
  board: boardSchema,
  pins: z.array(z.unknown()).max(MAX_PINS_PER_IMPORT)
}).strict();

export const publicIngestionPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().trim().min(1).max(200),
  exportedAt: z.string().datetime({ offset: true }),
  board: boardSchema,
  pins: z.array(pinSchema).max(MAX_PINS_PER_IMPORT)
}).strict();

export const assetStatusSchema = z.enum(['available', 'unavailable', 'invalid', 'disabled']);
export const collectionStatusSchema = z.enum(['active', 'disabled', 'error']);

export type IngestionEnvelope = z.infer<typeof envelopeShapeSchema>;
export type ValidatedPin = z.infer<typeof pinSchema>;
