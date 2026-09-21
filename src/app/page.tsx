import { redirect } from "next/navigation";
import { readSession } from "@/modules/auth/session";

export default async function HomePage() {
  const session = await readSession();
  if (session) redirect("/dashboard");
  redirect("/login");
}
