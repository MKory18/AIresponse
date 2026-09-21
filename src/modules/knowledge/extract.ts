import { AIError } from "@/core/errors";

/** Extracts plain text from uploaded document bytes (PDF, TXT, MD, CSV, JSON). */
export async function extractText(mimeType: string, filename: string, data: Buffer): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  if (mimeType === "application/pdf" || ext === "pdf") {
    try {
      // Import the library entry directly to avoid its debug-mode side effect.
      const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
      const result = await pdfParse(data);
      return result.text;
    } catch (err) {
      throw new AIError(
        `PDF text extraction failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  }

  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    ["txt", "md", "csv", "json"].includes(ext)
  ) {
    return data.toString("utf8");
  }

  throw new AIError(`No text extractor available for ${mimeType}`);
}
