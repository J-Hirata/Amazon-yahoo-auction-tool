import {build} from "esbuild";
import {mkdir, readFile, writeFile, copyFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {load} from "cheerio";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist", "cloud");
await mkdir(output, {recursive: true});
const {extensionArchive}=await import('./build-extension.mjs');
await copyFile(extensionArchive,path.join(output,'chrome-extension.zip'));
await build({entryPoints: [path.join(root, "public", "cloud-login.js")], outfile: path.join(output, "cloud-login.js"), bundle: true,
  format: "esm", target: ["es2022"], platform: "browser", minify: true, external: ["./monitor-http.js", "./link-monitor.js", "./physical-stock.js", "./app.js", "./sales-planning.js","./product-overview.js","./shared-photos.js","./photo-listing-drafts.js"], logLevel: "warning"});
await build({entryPoints: [path.join(root, "public", "physical-stock.js")], outfile: path.join(output, "physical-stock.js"), bundle: true,
  format: "esm", target: ["es2022"], platform: "browser", minify: true, external: ["./monitor-http.js", "./catalog-view.js"], logLevel: "warning"});
const files = ["cloud-login.html", "cloud-login.css", "cloud-demo.js", "app.js", "monitor-http.js", "link-monitor.js", "link-monitor.css", "physical-stock.css", "cloud-stock-view.html", "styles.css", "extension-logo.png"];
files.push("cloud-photos-view.html","shared-photos.js","shared-photo-images.js","shared-photos.css","draft-workspace.js","photo-listing-drafts.js","photo-listing-drafts.css","photo-draft-zip.js");
files.push("cloud-planning-view.html","sales-planning.css","product-access.js","product-access.css");
files.push("tile-size.js","fba-alarm.js","fba-status.js","draft-board.js","draft-workbench.css","extension-helper.html");
files.push("cloud-overview-view.html","overview-filters.js","product-overview.js","product-overview.css","workspace-drafts.png","workspace-stock.png","workspace-planning.png","workspace-overview.png","cockpit-mark.svg");
await build({entryPoints:[path.join(root,"public","sales-planning.js")],outfile:path.join(output,"sales-planning.js"),bundle:true,format:"esm",target:["es2022"],platform:"browser",minify:true,external:["./monitor-http.js","./catalog-view.js"],logLevel:"warning"});
await build({entryPoints:[path.join(root,"public","product-workspace.js")],outfile:path.join(output,"product-workspace.js"),bundle:true,format:"esm",target:["es2022"],platform:"browser",minify:true,logLevel:"warning"});
await build({entryPoints:[path.join(root,"public","inventory-panel.js")],outfile:path.join(output,"inventory-panel.js"),bundle:true,format:"esm",target:["es2022"],platform:"browser",minify:true,logLevel:"warning"});
for (const name of files) await copyFile(path.join(root, "public", name), path.join(output, name));
for(const name of ["catalog-view.js","catalog-view.css","catalog-list.svg","catalog-tiles.svg","catalog-image.svg","catalog-grip.svg","catalog-prev.svg","catalog-next.svg"])await copyFile(path.join(root,"public",name),path.join(output,name));
await build({stdin:{contents:'export {default} from "sortablejs";',resolveDir:root},outfile:path.join(output,"catalog-sortable.js"),bundle:true,format:"esm",platform:"browser",target:["es2022"],minify:true,legalComments:"inline",banner:{js:"/*\n"+await readFile(path.join(root,"node_modules","sortablejs","LICENSE"),"utf8")+"\n*/"}});
await build({entryPoints:[path.join(root,"public","product-workspace-editor.js")],outfile:path.join(output,"product-workspace-editor.js"),bundle:true,format:"esm",target:["es2022"],platform:"browser",minify:true,external:["./monitor-http.js"],logLevel:"warning"});
for (const name of ["index.html", "link-monitor.html"]) await copyFile(path.join(output, "cloud-login.html"), path.join(output, name));
await copyFile(path.join(root, "public", "cloud-demo.html"), path.join(output, "demo.html"));
const $ = load(await readFile(path.join(root, "public", "link-monitor.html"), "utf8"));
$(".monitor-header nav a").remove();
$(".monitor-header h1").text("商品紐付けツール");
const scheduleLabel = $("#monitoringEnabled").parent();
scheduleLabel.contents().filter((_, node) => node.type === "text").remove();
scheduleLabel.append("定期確認（クラウドは未接続）");
$("#testRegistrationMail").appendTo("#cloudMailControls");
await writeFile(path.join(output, "cloud-view.html"), $("main").toString(), "utf8");
const queue = load(await readFile(path.join(root, "public", "index.html"), "utf8"));
queue("main").addClass("workspace-drafts");
queue(".toolbar h1").first().text("ヤフオク出品下書きツール");
queue(".toolbar h1").first().siblings("p").remove();
queue('#draftHelp > summary').after('<section class="draft-capability-note" aria-label="下書きツールの対応範囲"><strong>選択した商品をヤフオクへ</strong><p>最大5商品を選んで入力画面を開けます。Chrome拡張1.0.4を登録・更新してください。商品名・価格案・説明・参考画像を渡し、入力・保存確認の記録をこの画面へ戻します。</p><a href="/extension-helper.html" target="_blank" rel="noopener noreferrer">Chrome拡張の更新・登録手順 ↗</a></section>');
for (const section of queue(".guide").toArray()) {
  const element = queue(section); const title = element.find("h2").first().text(); element.find("h2").first().remove();
  element.replaceWith(queue("<details class='guide cloud-help'></details>").append(queue("<summary></summary>").text(title), element.contents()));
}
for (const selector of ["#fetchProducts", "#copyYahooBookmarklet", "#copyYahooBookmarkletDraft"]) queue(selector).attr("disabled", "").attr("title", "PCローカル版で利用できます");
queue("#fetchProducts").attr("hidden", "");
queue("a[href='/link-monitor.html']").attr("href", "/").text("商品紐付けツール");
queue("a[href='/amazon-helper.html'],a[href='/yahoo-helper.html'],a[href='/stock-monitor.html']").removeAttr("href").attr("aria-disabled", "true").attr("title", "PC専用補助・旧監視は未接続です。登録データは保持しています").addClass("cloud-unavailable");
await writeFile(path.join(output, "cloud-drafts-view.html"), queue("main").toString(), "utf8");
console.log("Cloud assets built: dist/cloud (no credentials or business records included)");
