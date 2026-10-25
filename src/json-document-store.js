import {readFile, mkdir, open, rename, unlink} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {cloudCutover} from "./cloud-cutover.js";

export function createJsonDocumentStore({directory, filename, empty, validate}) {
  const file = path.join(directory, filename);
  let tail = Promise.resolve();
  async function load() {
    try { return validate(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if (error.code === "ENOENT") return empty(); throw error; }
  }
  function update(callback) {
    const operation = tail.then(async () => {
      if (await cloudCutover(directory)) throw Object.assign(new Error("クラウド版へ切替済みです。https://amazon-yahoo-inventory.vercel.app を開いてください。ローカルの控えは変更しません"), {code: "STORAGE_CLOUD_CUTOVER"});
      const state = await load();
      const result = await callback(state);
      validate(state);
      const content = JSON.stringify(state, null, 2) + "\n";
      await mkdir(directory, {recursive: true});
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx");
        try { await handle.writeFile(content); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => {}); }
      return result;
    });
    tail = operation.catch(() => {});
    return operation;
  }
  return {backend: "json", directory, read: async () => {await tail; return load();}, update};
}
