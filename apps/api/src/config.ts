import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: path.join(repositoryRoot, '.env') });

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const rootDirectory = path.resolve(process.cwd());
const generatedToken = crypto.randomBytes(24).toString('hex');
const secretsEncryptionKey = process.env.APP_SECRETS_ENCRYPTION_KEY?.trim();
if (!secretsEncryptionKey && process.env.NODE_ENV !== 'test')
  throw new Error(
    'APP_SECRETS_ENCRYPTION_KEY must be configured and kept stable across API restarts.',
  );

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: positiveInt(process.env.PORT, 3000),
  databasePath: path.resolve(rootDirectory, process.env.DATABASE_PATH ?? './data/tokia.sqlite'),
  contentStorageDirectory: path.resolve(rootDirectory, process.env.CONTENT_STORAGE_DIRECTORY ?? './data/content'),
  ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH?.trim() || 'ffprobe',
  maxUploadBytes: positiveInt(process.env.MAX_UPLOAD_BYTES, 250 * 1024 * 1024),
  secretsEncryptionKey: secretsEncryptionKey || crypto.randomBytes(32).toString('base64url'),
  modelProvider: process.env.MODEL_PROVIDER?.trim() || 'local',
  modelName: process.env.MODEL_NAME?.trim() || 'local-structured-v1',
  localIntegrationToken: process.env.LOCAL_INTEGRATION_TOKEN?.trim() || generatedToken,
  maxPinsPerImport: Math.min(10_000, positiveInt(process.env.MAX_PINS_PER_IMPORT, 2_000)),
  maxRequestBytes: positiveInt(process.env.MAX_REQUEST_BYTES, 10 * 1024 * 1024),
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? 'info'
} as const;

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return config.corsAllowedOrigins.includes(origin);
}
