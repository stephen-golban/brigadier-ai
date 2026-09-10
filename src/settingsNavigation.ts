export type SettingsPage = "general" | "profile" | "updates" | "archived";
export interface SettingsRequest {
  page?: SettingsPage;
  sessionId?: string;
}
export function openSettings(request: SettingsRequest = {}) {
  window.dispatchEvent(
    new CustomEvent("brigadier-settings", { detail: request }),
  );
}
export function viewChat(sessionId: string) {
  window.dispatchEvent(
    new CustomEvent("brigadier-view-chat", { detail: sessionId }),
  );
}
