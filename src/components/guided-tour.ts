"use client";

import "driver.js/dist/driver.css";
import { driver } from "driver.js";
import { TOUR_STEPS } from "@/lib/guided-tour";

/** أول عنصر ظاهر بهالعلامة (القائمة موجودة مرتين: الجانبية والدرج تبع الجوال). */
function visibleTarget(target: string): Element | null {
  const all = Array.from(document.querySelectorAll(`[data-tour="${target}"]`));
  return all.find((el) => el.getClientRects().length > 0) ?? null;
}

/**
 * بيشغّل الجولة على العناصر الظاهرة بس. الشكل من متغيّرات الثيم
 * (`.zr-tour` بـ`globals.css`) — فبتلبس أي ثيم مختار.
 */
export function startGuidedTour(onDone?: () => void) {
  const steps = TOUR_STEPS.flatMap((s) => {
    const el = visibleTarget(s.target);
    // القائمة على اليمين (RTL): الفقاعة على يسارها، وعناصر الشريط العلوي تحتها —
    // وإلا driver.js بيحطها برا الشاشة.
    const side = s.target.startsWith("group-") ? ("left" as const) : ("bottom" as const);
    return el ? [{ element: el, popover: { title: s.title, description: s.text, side, align: "start" as const } }] : [];
  });
  if (steps.length === 0) return;
  const tour = driver({
    steps,
    showProgress: true,
    progressText: "{{current}} من {{total}}",
    nextBtnText: "التالي",
    prevBtnText: "السابق",
    doneBtnText: "يلا نبلّش",
    popoverClass: "zr-tour",
    overlayOpacity: 0.45,
    stagePadding: 4,
    stageRadius: 10,
    onDestroyed: () => onDone?.(),
  });
  tour.drive();
}
