import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";

export class ImageConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageConversionError";
  }
}

export function isHeicImageUrl(value: string): boolean {
  return /\.(?:heic|heif)(?:[?#]|$)/i.test(value);
}

function runConverter(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new ImageConversionError(stderr.trim() || `HEIC conversion exited with code ${code}.`));
    });
  });
}

export async function convertHeicToJpeg(source: Uint8Array): Promise<Buffer> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "tokia-heic-"));
  const inputPath = path.join(directory, "source.heic");
  const outputPath = path.join(directory, "preview.jpg");
  try {
    await fsp.writeFile(inputPath, source);
    const command = process.env.TOKIA_HEIF_CONVERTER?.trim() || "heif-convert";
    await runConverter(command, [inputPath, outputPath]);
    return await fsp.readFile(outputPath);
  } catch (error) {
    if (error instanceof ImageConversionError) throw error;
    throw new ImageConversionError(error instanceof Error ? error.message : "The HEIC image could not be converted.");
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}
