import { redirectToMerged } from "@/lib/nav-redirect";

/** صفحة انشالت بقرار المالك (تركيز على الردود والطلبات) — الرابط القديم بيحوّل. */
export default function CampaignsPage() {
  redirectToMerged("/campaigns");
}
