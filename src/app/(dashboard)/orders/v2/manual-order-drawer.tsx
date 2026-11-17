"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Drawer } from "@/components/ui/drawer";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ORDERS_STRINGS as S } from "./strings";

interface ProductOpt {
  id: string;
  name: string;
  price: string | number;
  currency: string;
}
interface Line {
  key: number;
  productId: string;
  quantity: string;
}

const RULE_MESSAGES: Record<string, string> = {
  INVALID_PHONE: "رقم الهاتف مش صالح — اكتبه بالأرقام (مثلًا 0791234567).",
  ORDER_CUSTOMER_BLACKLISTED: "هالعميل بالقائمة السوداء — ما بيصير ينعمل له طلب.",
  DELIVERY_UNAVAILABLE: "التوصيل مش متاح لهالمحافظة.",
};

let nextKey = 1;
const newKey = () => nextKey++;
const newIdempotencyKey = () => `form-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * «طلب يدوي» (3.2، 03 §5.3): درج بنموذج قصير — العميل (هاتف · اسم · محافظة · عنوان) + المنتجات والكميات.
 * الطلب بيتثبّت فورًا بنفس القواعد والتسعير (السعر من القاعدة مش من الشاشة). تكرار محتمل = تنبيه وموافقة صريحة.
 * مفتاح عدم التكرار بيتولّد لكل فتح للنموذج: ضغطتين = طلب واحد.
 */
export function ManualOrderDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (orderId: string) => void }) {
  const toast = useToast();
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [provinces, setProvinces] = useState<string[]>([]);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ key: newKey(), productId: "", quantity: "1" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [idem, setIdem] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setIdem(newIdempotencyKey());
    setError(null);
    setDuplicate(false);
    api<{ items: ProductOpt[] }>("/api/products?status=active&limit=100").then((d) => setProducts(d.items)).catch(() => setProducts([]));
    api<{ provinces?: string[] }>("/api/delivery-rules").then((d) => setProvinces(d.provinces ?? [])).catch(() => setProvinces([]));
  }, [open]);

  const valid = useMemo(
    () => phone.trim().length >= 7 && name.trim() && province.trim().length >= 2 && address.trim().length >= 3 && lines.length > 0 && lines.every((l) => l.productId && Number.isInteger(Number(l.quantity)) && Number(l.quantity) >= 1),
    [phone, name, province, address, lines]
  );

  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function submit(allowDuplicate: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ orderId: string; orderNumber: string }>("/api/orders", {
        method: "POST",
        json: {
          customer: { phone: phone.trim(), name: name.trim(), province: province.trim(), address: address.trim(), ...(city.trim() ? { city: city.trim() } : {}) },
          items: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(allowDuplicate ? { allowDuplicate: true } : {}),
          idempotencyKey: idem,
        },
      });
      toast.show(`${S.manual.created} ${r.orderNumber}`, "success");
      setPhone("");
      setName("");
      setProvince("");
      setCity("");
      setAddress("");
      setNotes("");
      setLines([{ key: newKey(), productId: "", quantity: "1" }]);
      onCreated(r.orderId);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "DUPLICATE_ORDER") setDuplicate(true);
      else setError(e instanceof ApiError && e.code && RULE_MESSAGES[e.code] ? RULE_MESSAGES[e.code] : e instanceof Error ? e.message : S.manual.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={S.manual.title}
      footer={
        <Button onClick={() => void submit(false)} loading={busy} disabled={busy || !valid} className="w-full">
          {S.manual.submit}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">{S.manual.intro}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={S.manual.phone}>
            <Input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0791234567" />
          </Field>
          <Field label={S.manual.name}>
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={S.manual.province}>
            <Input list="manual-order-provinces" value={province} maxLength={80} onChange={(e) => setProvince(e.target.value)} />
            <datalist id="manual-order-provinces">
              {provinces.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <Field label={S.manual.city}>
            <Input value={city} maxLength={80} onChange={(e) => setCity(e.target.value)} />
          </Field>
        </div>
        <Field label={S.manual.address}>
          <Textarea rows={2} value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} />
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-ink">{S.manual.items}</legend>
          {lines.map((l) => (
            <div key={l.key} className="flex items-center gap-2">
              <Select aria-label={S.manual.product} value={l.productId} onChange={(e) => setLine(l.key, { productId: e.target.value })} className="min-w-0 flex-1">
                <option value="">{S.manual.pickProduct}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {Number(p.price)} {p.currency}
                  </option>
                ))}
              </Select>
              <Input aria-label={S.manual.quantity} dir="ltr" type="number" min={1} step={1} value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} className="w-20" />
              {lines.length > 1 && (
                <IconButton aria-label={S.manual.removeLine} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Trash2 size={16} aria-hidden />
                </IconButton>
              )}
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setLines((ls) => [...ls, { key: newKey(), productId: "", quantity: "1" }])}>
            <Plus size={14} aria-hidden /> {S.manual.addLine}
          </Button>
        </fieldset>

        <Field label={S.manual.notes}>
          <Textarea rows={2} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error && (
          <div role="alert" className="rounded-card border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-ink">
            {error}
          </div>
        )}
        {duplicate && (
          <div className="space-y-2">
            <Callout risk={S.manual.duplicateRisk} fix={S.manual.duplicateFix} />
            <Button variant="secondary" onClick={() => void submit(true)} loading={busy} disabled={busy}>
              {S.manual.duplicateConfirm}
            </Button>
          </div>
        )}
        <p className="text-caption text-ink-muted">{S.manual.priceNote}</p>
      </div>
    </Drawer>
  );
}
