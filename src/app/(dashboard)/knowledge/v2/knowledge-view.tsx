"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ui/card";
import { SegmentedControl, type SegmentOption } from "@/components/ui/segmented-control";
import { useCan } from "@/components/auth/permissions";
import type { Permission } from "@/modules/rbac/permissions";
import { FeedbackBody } from "../../feedback/feedback-body";
import { MediaBody } from "../../media/media-body";
import { KnowledgeBody } from "../knowledge-body";
import { KNOWLEDGE_STRINGS as S } from "./strings";

export type Section = "faq" | "docs" | "media" | "feedback";
const ORDER: ReadonlyArray<{ key: Section; permission: Permission }> = [
  { key: "faq", permission: "knowledge.read" },
  { key: "docs", permission: "knowledge.read" },
  { key: "media", permission: "media.read" },
  { key: "feedback", permission: "feedback.read" },
];

/** القسم المطلوب من `?tab=` — أول قسم مسموح إذا مش صالح أو ما عنده صلاحيته. */
export function resolveSection(raw: string | null, allowed: readonly Section[]): Section | null {
  if (raw && (allowed as readonly string[]).includes(raw)) return raw as Section;
  return allowed[0] ?? null;
}

/** «المعلومات» (3.5): مبدّل بأربعة أقسام، القسم بالرابط (`?tab=`)، وكل قسم بصلاحيته. */
export function KnowledgeView() {
  const can = useCan();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const allowed = useMemo(() => ORDER.filter((o) => can(o.permission)).map((o) => o.key), [can]);
  const section = resolveSection(params.get("tab"), allowed);

  const go = useCallback(
    (next: Section) => {
      const p = new URLSearchParams(params.toString());
      p.set("tab", next);
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [params, pathname, router]
  );

  // «أسرع بداية: سؤال شائع» من القائمة الفاضية للمستندات.
  useEffect(() => {
    const onGoto = (e: Event) => {
      const to = (e as CustomEvent<string>).detail;
      if (to === "faq" && allowed.includes("faq")) go("faq");
    };
    window.addEventListener("knowledge:goto", onGoto);
    return () => window.removeEventListener("knowledge:goto", onGoto);
  }, [allowed, go]);

  const options: SegmentOption<Section>[] = allowed.map((k) => ({ value: k, label: S.sections[k] }));
  if (!section) return <p className="text-sm text-ink-muted">ما عندك صلاحية تشوف المعلومات.</p>;
  return (
    <div className="page-wrap">
      <PageHeader title={S.title} description={S.description} />
      <SegmentedControl value={section} onChange={go} options={options} label={S.switcher} />
      {section === "faq" && <KnowledgeBody section="faq" embedded />}
      {section === "docs" && <KnowledgeBody section="docs" embedded />}
      {section === "media" && <MediaBody embedded />}
      {section === "feedback" && <FeedbackBody embedded />}
    </div>
  );
}
