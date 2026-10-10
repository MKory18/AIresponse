/**
 * Conversations service — barrel (P1 split, no logic change).
 *
 * - `./inbound`: processIncomingMessage pipeline entry point.
 * - `./threads`: guards, listing, detail, outbound, read/unread, soft-delete,
 *   assignment, takeover/release, status updates.
 *
 * All previous import paths (`@/modules/conversations/service`) keep working.
 */
export * from "./inbound";
export * from "./threads";
