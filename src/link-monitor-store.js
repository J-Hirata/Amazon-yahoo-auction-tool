import path from "node:path";
import {fileURLToPath} from "node:url";
import {emptyMonitor} from "./link-monitor.js";
import {createJsonDocumentStore} from "./json-document-store.js";
import {configuredDocumentStore} from "./storage-runtime.js";
import {validateMonitorState} from "./storage-validation.js";

export function createMonitorStore(directory) {
  return createJsonDocumentStore({directory, filename: "link-monitor.json", empty: emptyMonitor, validate: validateMonitorState});
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const monitorStore = configuredDocumentStore({key: "link-monitor", directory: process.env.LINK_MONITOR_DATA_DIR || root,
  filename: "link-monitor.json", empty: emptyMonitor, validate: validateMonitorState});
