import fs from 'node:fs';
import path from 'node:path';

// Explicit list: never copy the workspace, parent directories, Git history, or caches.
export const PUBLIC_FILES = [
  '.gitignore', 'README.md', 'PRIVACY.md', 'CHANGELOG.md',
  'manifest.json', 'package.json', 'popup.html', 'popup.js',
  'core.js', 'background.js', 'content.js', 'shipment-detail.js',
  'page-network.js', 'page-table.js',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
  'scripts/check-extension.mjs', 'scripts/release-archive.mjs', 'scripts/run-tests.mjs',
  'scripts/public-files.mjs', 'scripts/privacy-check.mjs', 'scripts/export-github.mjs'
];

export function publicFiles(projectDir) {
  const testDir = path.join(projectDir, 'test');
  if (fs.lstatSync(testDir).isSymbolicLink()) throw new Error('测试目录不能是符号链接');
  const tests = fs.readdirSync(testDir).filter(name => /^[a-z0-9-]+\.test\.m?js$/.test(name))
    .sort().map(name => `test/${name}`);
  const files = [...PUBLIC_FILES, ...tests];
  for (const relative of files) {
    let current = projectDir;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`公开文件不能引用符号链接：${relative}`);
    }
    if (!fs.statSync(current).isFile()) throw new Error(`不是普通发布文件：${relative}`);
  }
  return files;
}
