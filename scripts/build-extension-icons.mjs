import {createRequire} from "node:module";
import {mkdir, copyFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE || "sharp");
const root = new URL("../", import.meta.url);
const source = new URL("assets/extension-logo-source.png", root);
await mkdir(new URL("assets/", root), {recursive: true});
if (process.argv[2]) await copyFile(process.argv[2], source);
await mkdir(new URL("chrome-extension/icons/", root), {recursive: true});
for (const size of [16, 32, 48, 128]) {
  await sharp(fileURLToPath(source)).flatten({background: "#ffffff"}).resize(size, size).png().toFile(fileURLToPath(new URL(`chrome-extension/icons/icon${size}.png`, root)));
}
await sharp(fileURLToPath(source)).flatten({background: "#ffffff"}).resize(256, 256).png().toFile(fileURLToPath(new URL("public/extension-logo.png", root)));
console.log("Extension icons and registration-page logo generated.");
