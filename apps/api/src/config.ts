import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rootDirectory = path.resolve(process.cwd());
export const runtimeConfigPath = path.join(rootDirectory, 'data', 'tokia-settings.json');

export type RuntimeLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
export type RuntimeSettings = {
  host: string;
  port: number;
  databasePath: string;
  contentStorageDirectory: string;
  ffmpegPath: string;
  ffprobePath: string;
  maxUploadBytes: number;
  modelProvider: string;
  modelName: string;
  maxPinsPerImport: number;
  maxRequestBytes: number;
  corsAllowedOrigins: string[];
  logLevel: RuntimeLogLevel;
};

const defaultRawRuntimeSettings = {
  host: '127.0.0.1',
  port: 3000,
  databasePath: './data/tokia.sqlite',
  contentStorageDirectory: './data/content',
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  maxUploadBytes: 250 * 1024 * 1024,
  modelProvider: 'local',
  modelName: 'local-structured-v1',
  maxPinsPerImport: 2_000,
  maxRequestBytes: 10 * 1024 * 1024,
  corsAllowedOrigins: [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ],
  logLevel: 'info' as RuntimeLogLevel,
};

export const defaultRuntimeSettings: RuntimeSettings = {
  ...defaultRawRuntimeSettings,
  databasePath: path.resolve(rootDirectory, defaultRawRuntimeSettings.databasePath),
  contentStorageDirectory: path.resolve(rootDirectory, defaultRawRuntimeSettings.contentStorageDirectory),
};

function readRuntimeFile(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function positiveInt(value: unknown, fallback: number, maximum?: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return maximum ? Math.min(parsed, maximum) : parsed;
}

function pathValue(value: unknown, fallback: string): string {
  return path.resolve(rootDirectory, textValue(value, fallback));
}

function originsValue(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const origins = value.filter((origin): origin is string => typeof origin === 'string')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length ? origins : [...fallback];
}

function logLevelValue(value: unknown, fallback: RuntimeLogLevel): RuntimeLogLevel {
  const levels: RuntimeLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
  return typeof value === 'string' && levels.includes(value as RuntimeLogLevel) ? value as RuntimeLogLevel : fallback;
}

function loadRuntimeSettings(): RuntimeSettings {
  const stored = readRuntimeFile();
  return {
    host: textValue(stored.host, defaultRawRuntimeSettings.host),
    port: positiveInt(stored.port, defaultRawRuntimeSettings.port, 65_535),
    databasePath: pathValue(stored.databasePath, defaultRawRuntimeSettings.databasePath),
    contentStorageDirectory: pathValue(stored.contentStorageDirectory, defaultRawRuntimeSettings.contentStorageDirectory),
    ffmpegPath: textValue(stored.ffmpegPath, defaultRawRuntimeSettings.ffmpegPath),
    ffprobePath: textValue(stored.ffprobePath, defaultRawRuntimeSettings.ffprobePath),
    maxUploadBytes: positiveInt(stored.maxUploadBytes, defaultRawRuntimeSettings.maxUploadBytes),
    modelProvider: textValue(stored.modelProvider, defaultRawRuntimeSettings.modelProvider),
    modelName: textValue(stored.modelName, defaultRawRuntimeSettings.modelName),
    maxPinsPerImport: positiveInt(stored.maxPinsPerImport, defaultRawRuntimeSettings.maxPinsPerImport, 10_000),
    maxRequestBytes: positiveInt(stored.maxRequestBytes, defaultRawRuntimeSettings.maxRequestBytes),
    corsAllowedOrigins: originsValue(stored.corsAllowedOrigins, defaultRawRuntimeSettings.corsAllowedOrigins),
    logLevel: logLevelValue(stored.logLevel, defaultRawRuntimeSettings.logLevel),
  };
}

export function saveRuntimeSettings(settings: RuntimeSettings): void {
  fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
  const temporaryPath = `${runtimeConfigPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, runtimeConfigPath);
}

const runtimeSettings = loadRuntimeSettings();
const databaseDirectory = path.dirname(runtimeSettings.databasePath);
const generatedToken = crypto.randomBytes(24).toString('hex');

function loadOrCreateSecretsEncryptionKey(): string {
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
  nodeEnv: process.env.NODE_ENV === 'test' ? 'test' : 'development',
  ...runtimeSettings,
  secretsEncryptionKey,
  localIntegrationToken: generatedToken,
} as const;
