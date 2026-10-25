import {PREVIEW_CONFIG, candidatesFor, assessLink, notificationText, notificationPreview} from "./link-monitor.js";
import {notificationSettings} from "./notification-settings.js";

export function monitorView(state, {backend, fbaStatus, notificationStatus, notificationRuntime = false, runtimeMessage, revision, capabilities} = {}) {
  const at = new Date().toISOString();
  if (state.amazonInventory?.status === "running" && fbaStatus?.status !== "running") {
    state = {...state, amazonInventory: {...state.amazonInventory, status: "failed", complete: false, error: "前回の在庫確認が途中で停止しました。再度確認してください"}};
  }
  const settings = {...notificationSettings(state), ...(!notificationRuntime ? {mailEnabled: false, monitoringEnabled: false} : {})};
  return {...state, notificationSettings: settings, notificationJob: notificationStatus,
    storage: {backend, ...(revision === undefined ? {} : {revision})},
    config: {...PREVIEW_CONFIG, notificationRuntime, notificationRuntimeMessage: runtimeMessage || null,
      emailEnabled: settings.mailEnabled, schedulerEnabled: settings.monitoringEnabled, ...(capabilities ? {capabilities} : {})}, fbaJob: fbaStatus,
    listings: state.listings.map((item) => ({...item, candidates: candidatesFor(item, state.catalog)})),
    links: state.links.map((link) => ({...link, assessment: assessLink(link, state, at)})),
    events: state.events.map((event) => ({...event, text: notificationText(event), preview: notificationPreview(event)}))};
}
