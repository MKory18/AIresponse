/**
 * Shared pipeline state (P1 split of orchestrator.ts — types only, no logic).
 *
 * `AIExecutionResult` and `OrchestratorDeps` keep their canonical home here;
 * `orchestrator.ts` re-exports them so existing import paths keep working.
 */
import type { Conversation, Customer, Message } from "@prisma/client";
import type { Db } from "@/modules/customers/service";
import type { AIProvider } from "../provider";
import type { buildAIContext } from "../context-builder";
import type { handleOrderIntent } from "@/modules/orders/intelligence";
import type { loadMemory } from "../memory";
import type { resolveModel } from "../router";
import type { AISettingsLike } from "../router";
import type {
  ExtractionResult,
  ResponsePlan,
} from "../structured";
import type { PersonaConfig, Intent } from "../prompts";
import type { VectorStore } from "@/modules/knowledge/vector-store";

export interface AIExecutionResult {
  status: "RESPONDED" | "CLARIFIED" | "HANDOFF" | "SKIPPED" | "AI_DISABLED" | "AI_FAILED" | "DUPLICATE" | "NOT_INBOUND";
  intent?: Intent;
  confidence?: number;
  plan?: ResponsePlan;
  response?: string;
  citations?: { sourceType: string; sourceId: string }[];
  violations?: string[];
  executionId?: string;
  error?: string;
  /** Page-resolved AI persona driving this execution (channel → workspace). */
  persona?: { id: string | null; name: string; source: string };
}

export interface OrchestratorDeps {
  provider?: AIProvider;
  vectorStore?: VectorStore;
}

export interface PipelineParams {
  conversationId: string;
  messageId: string;
  workspaceId: string;
  dryRun?: boolean;
}

/** Cross-stage utilities owned by the sequencer (timings never leak content). */
export interface PipelineFx {
  pipelineStarted: number;
  stageMs: Record<string, number>;
  timed<T>(name: string, fn: () => Promise<T>): Promise<T>;
  logTimings(outcome: string, extra?: Record<string, unknown>): void;
}

export interface CustomerPII {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}

/** Everything gating loads before any model call. */
export interface GatingState {
  message: Message;
  conversation: Conversation;
  settings: AISettingsLike | null;
  persona: PersonaConfig;
  activePersona: { id: string | null; name: string; source: string; version: number | null };
  /**
   * External-provider reply path (Hermes): the SELECTED local persona still
   * drives voice (the gateway carries no personaId parameter). This flag only
   * suspends AUTOMATIC handoffs — activating a persona never reintroduces
   * them, and failures keep conversations OPEN with no HumanHandoff records.
   */
  hermesPersona: boolean;
  customer: Customer;
  channelRow: { displayName: string | null; externalId: string | null } | null;
  customerText: string;
  recentMessages: { senderType: string; direction: string; text: string | null }[];
  customerPII: CustomerPII;
  trustedContacts: string[];
  provider: AIProvider;
}

/** Everything extraction decides before response generation. */
export interface ExtractionReady {
  extraction: ExtractionResult;
  orderResult: Awaited<ReturnType<typeof handleOrderIntent>> | null;
  memories: Awaited<ReturnType<typeof loadMemory>>;
  context: Awaited<ReturnType<typeof buildAIContext>>;
  responseModelCfg: ReturnType<typeof resolveModel>;
  plan: ResponsePlan;
  extractionUser: string;
  /** P8 — خطة بيع حتمية (أرقام من DB فقط)؛ اختيارية ولا تغير السلوك غيابًا. */
  salesPlan?: import("@/modules/sales/plan-schemas").SalesPlan;
}

export type { Db };
