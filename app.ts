import { initHelpdeskNotifications } from "./src/tabs/helpdesk";
import { switchTab } from "./src/ui";

export async function init(): Promise<void> {
  initHelpdeskNotifications();
  switchTab("daily-ops");
}
