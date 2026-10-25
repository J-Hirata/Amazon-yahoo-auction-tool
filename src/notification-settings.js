export const NOTIFICATION_ADDRESS = "tokyotojjjj@gmail.com";

export function notificationSettings(state) {
  return {mailEnabled: false, monitoringEnabled: false, intervalMinutes: 30, ...state.notificationSettings, recipient: NOTIFICATION_ADDRESS};
}
