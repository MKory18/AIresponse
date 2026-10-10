import { enforcePermission } from "@/components/empty-section";
import TeamView from "./team-view";

export default async function TeamPage() {
  await enforcePermission("users.manage");
  return <TeamView />;
}
