import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { AppError } from "@/core/errors";
import { randomId } from "@/core/crypto";

export const UPLOAD_LIMITS = {
  IMAGE: 10 * 1024 * 1024,
  VIDEO: 100 * 1024 * 1024,
  AUDIO: 50 * 1024 * 1024,
  DOCUMENT: 25 * 1024 * 1024,
} as const;

export const ALLOWED_MIME_TYPES: Record<string, { ext: string; type: keyof typeof UPLOAD_LIMITS }> = {
  "image/jpeg": { ext: "jpg", type: "IMAGE" },
  "image/png": { ext: "png", type: "IMAGE" },
  "image/webp": { ext: "webp", type: "IMAGE" },
  "image/gif": { ext: "gif", type: "IMAGE" },
  "video/mp4": { ext: "mp4", type: "VIDEO" },
  "video/webm": { ext: "webm", type: "VIDEO" },
  "audio/mpeg": { ext: "mp3", type: "AUDIO" },
  "audio/wav": { ext: "wav", type: "AUDIO" },
  "audio/ogg": { ext: "ogg", type: "AUDIO" },
  "application/pdf": { ext: "pdf", type: "DOCUMENT" },
  "text/plain": { ext: "txt", type: "DOCUMENT" },
  "text/markdown": { ext: "md", type: "DOCUMENT" },
  "application/json": { ext: "json", type: "DOCUMENT" },
  "text/csv": { ext: "csv", type: "DOCUMENT" },
};

/** Extensions that must never be accepted regardless of claimed mime type. */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "bat", "cmd", "com", "scr", "sh", "ps1", "msi", "jar", "vbs", "js", "php", "asp", "aspx", "html", "htm", "svg",
]);

export function mediaTypeForMime(mimeType: string): keyof typeof UPLOAD_LIMITS {
  const entry = ALLOWED_MIME_TYPES[mimeType];
  if (!entry) throw new AppError(`Unsupported file type: ${mimeType}`, 422, "UNSUPPORTED_MEDIA_TYPE");
  return entry.type;
}

/** Validates mime + extension + size. Throws AppError(422) on any violation. */
export function validateUpload(input: {
  mimeType: string;
  filename: string;
  size: number;
}): { mediaType: keyof typeof UPLOAD_LIMITS; safeName: string } {
  const { mimeType, filename, size } = input;
  const entry = ALLOWED_MIME_TYPES[mimeType];
  if (!entry) {
    throw new AppError(`Unsupported file type: ${mimeType}`, 422, "UNSUPPORTED_MEDIA_TYPE");
  }

  // Strip directories and dangerous characters from the user filename.
  const base = path.basename(filename).replace(/[^\p{L}\p{N}._ -]/gu, "");
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new AppError("Executable and script files are not allowed", 422, "BLOCKED_FILE_TYPE");
  }
  const safeName = `${base.replace(/\.[^.]*$/, "").slice(0, 80) || "file"}.${entry.ext}`;

  const limit = UPLOAD_LIMITS[entry.type];
  if (size <= 0) throw new AppError("Empty file", 422, "EMPTY_FILE");
  if (size > limit) {
    throw new AppError(
      `File too large (max ${Math.round(limit / 1024 / 1024)}MB for ${entry.type.toLowerCase()}s)`,
      422,
      "FILE_TOO_LARGE"
    );
  }
  return { mediaType: entry.type, safeName };
}

export interface StoredFile {
  storageKey: string;
  url: string;
}

export interface StorageProvider {
  put(key: string, data: Buffer, mimeType: string): Promise<StoredFile>;
  get(key: string): Promise<{ stream: Readable; size: number } | null>;
  delete(key: string): Promise<void>;
}

export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(rootDir?: string) {
    this.root = rootDir ?? process.env.STORAGE_DIR ?? path.join(process.cwd(), ".data", "storage");
  }

  async put(key: string, data: Buffer): Promise<StoredFile> {
    const filePath = path.join(this.root, key);
    // Path traversal guard (same as get/delete).
    if (!path.resolve(filePath).startsWith(path.resolve(this.root) + path.sep)) {
      throw new AppError("Invalid storage key", 400, "INVALID_STORAGE_KEY");
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return { storageKey: key, url: `/api/media/file/${key}` };
  }

  async get(key: string) {
    const filePath = path.join(this.root, key);
    // Path traversal guard: resolved path must stay inside the storage root
    // (separator included so a sibling like `<root>-evil` cannot pass).
    if (!path.resolve(filePath).startsWith(path.resolve(this.root) + path.sep)) return null;
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    return { stream: createReadStream(filePath), size: stat.size };
  }

  async delete(key: string) {
    const filePath = path.join(this.root, key);
    if (path.resolve(filePath).startsWith(path.resolve(this.root) + path.sep) && existsSync(filePath)) {
      await unlink(filePath);
    }
  }
}

const globalForStorage = globalThis as typeof globalThis & { __acreStorage?: StorageProvider };

export function getStorage(): StorageProvider {
  if (!globalForStorage.__acreStorage) {
    globalForStorage.__acreStorage = new LocalStorageProvider();
  }
  return globalForStorage.__acreStorage;
}

export function generateStorageKey(workspaceId: string, safeName: string): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${workspaceId}/${yyyy}/${mm}/${randomId(8)}-${safeName}`;
}
