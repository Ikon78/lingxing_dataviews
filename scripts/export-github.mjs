import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPublicClean } from './privacy-check.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectDir, 'dist');
const outputDir = path.join(outputRoot, 'github');
const version = JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无效版本号');
const archiveName = `lingxing-field-merger-github-v${version}.zip`;
const archive = path.join(outputRoot, archiveName);
if (fs.existsSync(outputDir) || fs.existsSync(archive) || fs.existsSync(`${archive}.sha256`)) {
  throw new Error('公开导出已存在；请先核对并自行移动旧导出，本脚本不会覆盖或删除。');
}
if (fs.existsSync(outputRoot) && (fs.lstatSync(outputRoot).isSymbolicLink() || !fs.statSync(outputRoot).isDirectory())) {
  throw new Error('dist 必须是普通目录，不能是符号链接');
}

const files = assertPublicClean(projectDir);
execFileSync(process.execPath, ['scripts/run-tests.mjs'], { cwd: projectDir, stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/check-extension.mjs'], { cwd: projectDir, stdio: 'inherit' });
fs.mkdirSync(outputDir, { recursive: true });
for (const relative of files) {
  const destination = path.join(outputDir, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(projectDir, relative), destination, fs.constants.COPYFILE_EXCL);
}
assertPublicClean(outputDir);
// Explicit names include .gitignore; no shell glob can pull private neighbors into the ZIP.
execFileSync('zip', ['-X', '-q', archive, ...files], { cwd: outputDir, stdio: 'inherit' });
execFileSync('unzip', ['-tqq', archive], { stdio: 'inherit' });
const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${digest}  ${archiveName}\n`, { flag: 'wx' });
console.log(`GitHub 上传目录：${outputDir}`);
console.log(`脱敏源码 ZIP：${archive}`);
console.log(`SHA-256：${digest}`);
