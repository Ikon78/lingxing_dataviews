import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveDir = path.resolve(projectDir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version) || version !== pkg.version) throw new Error("manifest.json 与 package.json 的版本号不一致或无效");
const changelog = fs.readFileSync(path.join(projectDir, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## v${version} `)) throw new Error(`CHANGELOG.md 缺少 v${version} 的变更记录`);

const name = `领星跨页面字段库正式版-v${version}.zip`;
const destination = path.join(archiveDir, name);
const checksumPath = `${destination}.sha256`;
if (fs.existsSync(destination) || fs.existsSync(checksumPath)) throw new Error(`v${version} 已归档；请提升版本号，不要覆盖历史文件`);

execFileSync(process.execPath, ["scripts/privacy-check.mjs"], { cwd: projectDir, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/run-tests.mjs"], { cwd: projectDir, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/check-extension.mjs"], { cwd: projectDir, stdio: "inherit" });

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxing-field-release-"));
try {
  const temporaryArchive = path.join(temporaryDir, name);
  const { publicFiles } = await import('./public-files.mjs');
  const entries = publicFiles(projectDir);
  execFileSync("zip", ["-q", "-r", temporaryArchive, ...entries], { cwd: projectDir, stdio: "inherit" });
  execFileSync("unzip", ["-tqq", temporaryArchive], { stdio: "inherit" });
  const digest = crypto.createHash("sha256").update(fs.readFileSync(temporaryArchive)).digest("hex");
  fs.copyFileSync(temporaryArchive, destination, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(checksumPath, `${digest}  ${name}\n`, { flag: "wx" });
  console.log(`已归档：${destination}`);
  console.log(`SHA-256：${digest}`);
} finally {
  fs.rmSync(temporaryDir, { recursive: true, force: true });
}
