import fs from 'node:fs';
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
const databaseDirectory = path.dirname(path.resolve(rootDirectory, process.env.DATABASE_PATH ?? './data/tokia.sqlite'));

function loadOrCreateSecretsEncryptionKey(): string {
  const configured = process.env.APP_SECRETS_ENCRYPTION_KEY?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'test') return crypto.randomBytes(32).toString('base64url');

  const secretsPath = path.join(databaseDirectory, '.tokia-secrets.json');
  try {
    const stored = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as { encryptionKey?: unknown };
    if (typeof stored.encryptionKey === 'string' && stored.encryptionKey.length >= 32) return stored.encryptionKey;
  } catch {
    // A new local installation creates its runtime secret below.
  }

  const generated = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(databaseDirectory, { recursive: true });
  fs.writeFileSync(secretsPath, JSON.stringify({ version: 1, encryptionKey: generated }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return generated;
}

const secretsEncryptionKey = loadOrCreateSecretsEncryptionKey();

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
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3000,http://localhost:3000')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? 'info'
} as const;

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return config.corsAllowedOrigins.includes(origin);
}
