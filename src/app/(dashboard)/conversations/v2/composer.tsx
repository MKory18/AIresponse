"use client";

import { useState } from "react";
import { Paperclip, Send } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { MediaPicker } from "@/components/inbox/MediaPicker";

/**
 * المؤلّف (3.1): نص + إرفاق من المكتبة + إرسال. «ملاحظة داخلية» مربع اختيار بيغيّر لون المؤلّف (بدل تبويبين).
 * Enter بيرسل، Shift+Enter سطر جديد. `draft`/`setDraft` من فوق (اقتراحات الرد بتدرج فيه).
 */
export function Composer({
  draft,
  setDraft,
  onSend,
  onNote,
  disabled,
}: {
  draft: string;
  setDraft: (v: string) => void;
  onSend: (text: string, mediaId?: string) => Promise<boolean>;
  onNote: (text: string) => Promise<boolean>;
  disabled?: boolean;
}) {
  const [asNote, setAsNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function submit(mediaId?: string) {
    if (busy || (!draft.trim() && !mediaId)) return;
    setBusy(true);
    const text = draft;
    setDraft("");
    const ok = asNote ? await onNote(text) : await onSend(text, mediaId);
    // الإرسال الفاشل بيضل ظاهر بالمحادثة مع «أعد الإرسال»؛ الملاحظة الفاشلة بنرجّع نصها للمحرر.
    if (!ok && asNote) setDraft(text);
    setBusy(false);
  }

  return (
    <div className="border-t border-line bg-surface-2 p-3" data-composer>
      <div className={cn("flex items-end gap-1 rounded-card border p-1.5", asNote ? "border-warning/50 bg-warning-soft" : "border-border-strong bg-surface-2")}>
        <IconButton aria-label="أرفق من المكتبة" disabled={asNote || busy || disabled} onClick={() => setPickerOpen(true)}>
          <Paperclip size={18} aria-hidden />
        </IconButton>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          disabled={disabled}
          placeholder={asNote ? "ملاحظة للفريق فقط — العميل ما بيشوفها…" : "اكتب ردك…"}
          aria-label={asNote ? "ملاحظة داخلية" : "رد للعميل"}
          className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-subtle"
        />
        <Button onClick={() => void submit()} disabled={busy || disabled || !draft.trim()} loading={busy} size="icon" aria-label={asNote ? "أضف الملاحظة" : "أرسل"} className="h-10 w-10 shrink-0">
          {!busy && <Send size={16} className="-scale-x-100" aria-hidden />}
        </Button>
      </div>
      <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-sm text-ink-muted">
        <input type="checkbox" checked={asNote} onChange={(e) => setAsNote(e.target.checked)} className="h-4 w-4 accent-brand-500" />
        ملاحظة داخلية (للفريق فقط)
      </label>
      <MediaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(mediaId) => {
          setPickerOpen(false);
          void submit(mediaId);
        }}
      />
    </div>
  );
}
