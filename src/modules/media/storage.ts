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

/**
 * Best-effort magic-byte verification so a renamed script (evil.jpg containing
 * HTML/JS) or a mismatched payload can't pass on extension+MIME alone.
 *
 * Conservative by design: it throws ONLY on positive evidence of mismatch —
 * bytes that unambiguously identify a different binary family, or markup
 * (`<...`) masquerading as an image/document. Opaque/generic bytes pass
 * through to the MIME/extension/size checks, so valid uploads are never
 * rejected on a heuristic.
 * Throws AppError(422, CORRUPT_FILE) on positive mismatch.
 */
export function assertMagicBytes(mimeType: string, data: Buffer): void {
  if (data.length === 0) throw new AppError("Empty file", 422, "EMPTY_FILE");
  const sniffed = sniffContentType(data);
  if (!sniffed) return;
  if (sniffed === "markup") {
    if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
      throw new AppError("File content does not match the declared image/document type", 422, "CORRUPT_FILE");
    }
    return;
  }
  const claimedFamily =
    mimeType === "image/png" ? "png"
    : mimeType === "image/jpeg" ? "jpeg"
    : mimeType === "image/gif" ? "gif"
    : mimeType === "image/webp" ? "webp"
    : mimeType === "application/pdf" ? "pdf"
    : mimeType === "video/mp4" ? "mp4"
    : null;
  // Only compare when both sides are positively identified binary families.
  if (claimedFamily && sniffed !== "unknown-binary" && sniffed !== claimedFamily) {
    throw new AppError(`File content does not match ${mimeType}`, 422, "CORRUPT_FILE");
  }
}

/** Identifies unambiguous content families from leading bytes; null = opaque. */
function sniffContentType(data: Buffer): "png" | "jpeg" | "gif" | "webp" | "pdf" | "zip" | "mp4" | "markup" | "unknown-binary" | null {
  const h = data.subarray(0, 12);
  if (h.length >= 4 && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return "png";
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "jpeg";
  if (h.length >= 3 && h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return "gif";
  if (h.length >= 12 && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return "webp";
  if (h.length >= 4 && h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) return "pdf";
  if (h.length >= 4 && h[0] === 0x50 && h[1] === 0x4b && (h[2] === 0x03 || h[2] === 0x05 || h[2] === 0x07)) return "zip";
  if (h.length >= 8 && h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) return "mp4";
  // Leading markup (HTML/XML/SVG/script) after optional whitespace/BOM.
  let i = 0;
  if (h.length >= 3 && h[0] === 0xef && h[1] === 0xbb && h[2] === 0xbf) i = 3;
  while (i < h.length && (h[i] === 0x20 || h[i] === 0x09 || h[i] === 0x0a || h[i] === 0x0d)) i++;
  if (i < h.length && h[i] === 0x3c) return "markup";
  return null;
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

/** Encodes a storage key for use in a URL path (per-segment, so `/` separators survive). */
export function encodeStorageKeyUrl(key: string): string {
  return key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/** RFC 5987 Content-Disposition value supporting Unicode (Arabic) filenames. */
export function contentDispositionInline(filename: string): string {
  const fallback = filename.replace(/["\r\n]/g, "").slice(0, 120) || "file";
  return `inline; filename="${encodeURIComponent(fallback)}"; filename*=UTF-8''${encodeURIComponent(fallback)}`;
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
    return { storageKey: key, url: `/api/media/file/${encodeStorageKeyUrl(key)}` };
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
