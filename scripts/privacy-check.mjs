import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicFiles } from './public-files.mjs';

export function textFindings(text) {
  const findings = [];
  const add = (label, regex, accept = () => false) => {
    for (const match of text.matchAll(regex)) {
      if (!accept(match)) findings.push({ label, line: text.slice(0, match.index).split('\n').length });
    }
  };
  add('非示例企业域名', /https?:\/\/([a-z0-9.-]+)\.lingxing\.com\b/gi,
    match => match[1] === 'example');
  add('本机用户绝对路径', /\/(?:Users|home)\/[^/\s"'`]+/g);
  add('实际格式业务单号', /\b(?:SP\d{6,}|FBA[A-Z0-9]{6,})\b/g,
    match => /^(?:SP|FBA)0{5,}\d+$/.test(match[0]));
  add('非数字占位 ASIN', /\bB0[A-Z0-9]{8}\b/g, match => /^B\d{9}$/.test(match[0]));
  add('非示例店铺前缀', /\b(?:WE|MH|WR)[- ]/g);
  add('常见密钥格式', /\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[a-zA-Z0-9_-]{24,})\b/g);
  add('PEM 私钥', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g);
  add('JWT 格式会话凭据', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g);
  add('非占位凭据赋值', /["']?(?:password|passwd|authorization|access_token|refresh_token|client_secret|api_key)["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi,
    match => /^(?:REDACTED|EXAMPLE|TEST|DEMO|PLACEHOLDER|<)/i.test(match[1]));
  add('邮箱地址', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    match => /@(?:example\.(?:com|org|net)|localhost)$/i.test(match[0]));
  return findings;
}

export function pngFindings(buffer) {
  const invalid = label => [{ label, line: 0 }];
  if (buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return invalid('图标不是有效 PNG');
  const allowed = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'pHYs']);
  let cursor = 8;
  while (cursor + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    const type = buffer.toString('ascii', cursor + 4, cursor + 8);
    if (cursor + length + 12 > buffer.length) return invalid('PNG 数据边界无效');
    if (!allowed.has(type)) return invalid('PNG 含 EXIF、文本或其他未批准元数据');
    cursor += length + 12;
    if (type === 'IEND') return cursor === buffer.length ? [] : invalid('PNG 末尾有附加数据');
  }
  return invalid('PNG 缺少完整结束块');
}

export function scanPublicFiles(projectDir, files = publicFiles(projectDir)) {
  const findings = [];
  for (const relative of files) {
    if (relative.startsWith('icons/') && relative.endsWith('.png')) {
      findings.push(...pngFindings(fs.readFileSync(path.join(projectDir, relative))).map(item => ({ file: relative, ...item })));
      continue;
    }
    const contents = fs.readFileSync(path.join(projectDir, relative), 'utf8');
    findings.push(...textFindings(contents).map(item => ({ file: relative, ...item })));
  }
  return findings;
}

export function assertPublicClean(projectDir, files = publicFiles(projectDir)) {
  const findings = scanPublicFiles(projectDir, files);
  // Report locations/categories only: never echo a possible secret to a log.
  if (findings.length) throw new Error(`发布隐私检查未通过：\n${findings.map(item => `${item.file}:${item.line} ${item.label}`).join('\n')}`);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const files = assertPublicClean(projectDir);
    console.log(`发布隐私检查通过：${files.length} 个白名单文件；不包含上级目录、旧 Git 历史或浏览器缓存。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
