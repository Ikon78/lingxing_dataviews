import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { textFindings, pngFindings, scanPublicFiles } from '../scripts/privacy-check.mjs';
import { publicFiles } from '../scripts/public-files.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('隐私检查允许明确示例域名、占位 ASIN 与零填充示例单号', () => {
  assert.deepEqual(textFindings('https://example.lingxing.com B000000001 SP000000001 FBA000000001 DEMO-US TEST-One-US'), []);
});

test('隐私检查拒绝非示例企业域名，不把实际命中值放进报告', () => {
  const findings = textFindings('https://' + 'private-tenant' + '.lingxing.com/erp/listing');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].label, '非示例企业域名');
  assert.deepEqual(Object.keys(findings[0]).sort(), ['label', 'line']);
});

test('隐私检查拒绝本机路径、实际格式单号和非占位 ASIN', () => {
  for (const value of ['/Users' + '/example-user/docs', 'SP' + '202501019', 'FBA' + 'ABCDEFG123', 'B0' + 'EXAMPLE1']) {
    assert.ok(textFindings(value).length > 0);
  }
});

test('隐私检查拒绝常见密钥、私钥、JWT 与非示例邮箱', () => {
  const jwt = ['eyJ' + 'a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].join('.');
  for (const value of ['ghp_' + 'x'.repeat(36), '-----BEGIN ' + 'PRIVATE KEY-----', jwt, 'person' + '@' + 'private.invalid']) {
    assert.ok(textFindings(value).length > 0);
  }
  assert.deepEqual(textFindings('contact@example.com'), []);
});

test('隐私检查拒绝硬编码凭据，只接受明确占位符', () => {
  assert.ok(textFindings('api_key' + ': "' + 'a'.repeat(32) + '"').length > 0);
  assert.deepEqual(textFindings('api_key: "REDACTED_TEST_VALUE"'), []);
});

test('图标检查拒绝 EXIF、文本元数据和文件末尾附加内容', () => {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const chunk = type => { const data = Buffer.alloc(12); data.write(type, 4); return data; };
  const plain = Buffer.concat([signature, chunk('IHDR'), chunk('IDAT'), chunk('IEND')]);
  assert.deepEqual(pngFindings(plain), []);
  for (const type of ['eXIf', 'tEXt', 'iTXt', 'zTXt']) {
    assert.ok(pngFindings(Buffer.concat([signature, chunk(type), chunk('IEND')])).length > 0);
  }
  assert.ok(pngFindings(Buffer.concat([plain, Buffer.from('extra')])).length > 0);
  assert.ok(pngFindings(Buffer.from('not a png')).length > 0);
});

test('公开文件白名单包括 README、gitignore、隐私说明与测试，排除内部资料和 Git 历史', () => {
  const files = publicFiles(projectDir);
  for (const name of ['README.md', '.gitignore', 'PRIVACY.md', 'test/privacy-publication.test.mjs', 'manifest.json']) assert.ok(files.includes(name));
  assert.ok(files.every(name => !/(?:^|\/)(?:\.git|\.DS_Store|dist|node_modules|验收记录|稳定版本)(?:\/|$)|\.(?:zip|har|csv|xlsx|sha256)$/.test(name)));
  assert.equal(files.length, new Set(files).size);
});

test('公开发布文件通过隐私检查；文档不链接上级私有目录', () => {
  assert.deepEqual(scanPublicFiles(projectDir), []);
  for (const name of ['README.md', 'CHANGELOG.md', 'PRIVACY.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(projectDir, name), 'utf8'), /\]\(\.\.\//);
  }
});

test('忽略规则覆盖敏感文件和构建产物，导出不覆盖旧数据', () => {
  const ignore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8');
  for (const name of ['.env', '*.key', '*.pem', 'dist/', '验收记录/', '稳定版本/', '*.har', '*.zip', 'cookies*.json']) assert.ok(ignore.split('\n').includes(name));
  const exporter = fs.readFileSync(path.join(projectDir, 'scripts/export-github.mjs'), 'utf8');
  assert.ok(exporter.indexOf('assertPublicClean(projectDir)') < exporter.indexOf('fs.mkdirSync(outputDir'));
  assert.match(exporter, /COPYFILE_EXCL/);
  assert.doesNotMatch(exporter, /rmSync|shell:\s*true/);
});
