import {copyFile} from "node:fs/promises";
// Package local code; Manifest V3 never downloads executable code from the server.
await copyFile(new URL("../public/yahoo-fill.js", import.meta.url), new URL("../chrome-extension/yahoo-fill.js", import.meta.url));
console.log("Chrome extension prepared: chrome-extension");
