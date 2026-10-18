import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 chars (hex/base64)"),
  AI_PROVIDER: z.enum(["openai", "openrouter", "anthropic", "google"]).optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_REDIRECT_URI: z.string().optional(),
  META_GRAPH_VERSION: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  STORAGE_PROVIDER: z.string().default("local"),
  STORAGE_DIR: z.string().optional(),
  APP_URL: z.string().optional(),
  JOBS_SECRET: z.string().optional(),
  WORKER_POLL_INTERVAL_MS: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  ALLOW_MOCK_AI: z.string().optional(),
  AI_REQUEST_TIMEOUT_MS: z.string().optional(),
  FACEBOOK_SEND_TIMEOUT_MS: z.string().optional(),
  ORPHAN_MAX_AGE_HOURS: z.string().optional(),
  // مدة الاحتفاظ بوسائط الزبون الواردة بالأيام (افتراضي 180 · `0` = مطفي).
  WA_MEDIA_RETENTION_DAYS: z.string().optional(),
  // مدة الاحتفاظ بحمولة أحداث القنوات الخام بالأيام (افتراضي 30 · `0` = مطفي).
  WEBHOOK_PAYLOAD_RETENTION_DAYS: z.string().optional(),
  EMBEDDING_DIMENSIONS: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  CLASSIFICATION_MODEL: z.string().optional(),
  EXTRACTION_MODEL: z.string().optional(),
  RESPONSE_MODEL: z.string().optional(),
  VISION_MODEL: z.string().optional(),
  SUMMARY_MODEL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/** Test-only: drop the cached env so process.env changes take effect. */
export function resetEnvCache(): void {
  cached = null;
}

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration -> ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
