import fs from "node:fs";
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const files = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((item) => item.js),
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action.default_icon || {})
];
for (const file of files) if (!fs.existsSync(new URL(`../${file}`, import.meta.url))) throw new Error(`缺少扩展入口：${file}`);
if (manifest.permissions.some((item) => !["storage", "unlimitedStorage"].includes(item))) throw new Error("正式版申请了额外权限");
console.log(`正式版静态检查通过：${files.length} 个入口文件。`);
