/**
 * حالات «الرسالة طلعت فعلًا»: SENT وما بعده من إشارات التسليم (واتساب بينقل
 * الصف SENT ← DELIVERED ← READ). ملف مستقل بلا اعتماديات لأن outbound بيستورد
 * media/service، فما بيصير media/service يستورد منه.
 */
export const ALREADY_SENT_STATUSES = ["SENT", "DELIVERED", "READ"] as const;

export const ALREADY_SENT: ReadonlySet<string> = new Set(ALREADY_SENT_STATUSES);
