import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = fs.readdirSync(path.join(projectDir, 'test'))
  .filter(name => /^[a-z0-9-]+\.test\.m?js$/.test(name)).sort().map(name => `test/${name}`);
if (!tests.length) throw new Error('没有找到测试文件');
// An explicit list prevents generated dist/github/test copies from running twice.
try {
  execFileSync(process.execPath, ['--test', ...tests], { cwd: projectDir, stdio: 'inherit' });
} catch (error) {
  process.exitCode = Number.isInteger(error.status) ? error.status : 1;
}
