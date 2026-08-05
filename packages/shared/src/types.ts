export const PROVIDER_PINTEREST = 'pinterest' as const;
export type Provider = typeof PROVIDER_PINTEREST;

export type CollectionStatus = 'active' | 'disabled' | 'error';
export type AssetStatus = 'available' | 'unavailable' | 'invalid' | 'disabled';
export type ImportRunStatus = 'processing' | 'completed' | 'completed_with_warnings' | 'failed';

export interface ImageVariant {
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface IngestionBoard {
  externalId?: string | null;
  name: string;
  url: string;
  description?: string | null;
}

export interface IngestionPin {
  externalId?: string | null;
  pinUrl?: string | null;
  imageUrl: string;
  previewUrl?: string | null;
  imageVariants?: ImageVariant[];
  title?: string | null;
  description?: string | null;
  altText?: string | null;
  sourceLink?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface IngestionPayload {
  schemaVersion: 1;
  source: string;
  exportedAt: string;
  board: IngestionBoard;
  pins: IngestionPin[];
}

export interface NormalizedPin extends IngestionPin {
  provider: Provider;
  externalId: string | null;
  canonicalUrl: string | null;
  normalizedImageKey: string | null;
  identityKey: string;
  imageUrl: string;
  previewUrl: string | null;
  imageVariants: ImageVariant[];
}

export interface ImportSummary {
  received: number;
  valid: number;
  invalid: number;
  assetsCreated: number;
  assetsUpdated: number;
  membershipsCreated: number;
  duplicatesSkipped: number;
}

export interface ImportWarning {
  index: number;
  message: string;
}

export interface ImportResponse {
  success: true;
  collection: {
    id: string;
    name: string;
    created: boolean;
  };
  importRunId: string;
  summary: ImportSummary;
  warnings: ImportWarning[];
}
