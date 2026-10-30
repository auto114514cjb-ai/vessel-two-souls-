import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, atomicWrite, loadJson, validateConfig } from './core.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const START = '# BEGIN SHARED-AI-DESK BRIDGE';
const END = '# END SHARED-AI-DESK BRIDGE';
export function installHarness({ dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), appRoot = root, remove = false } = {}) {
  const profile = path.join(dshHome, 'profiles', 'desktop');
  if (!fs.existsSync(path.join(profile, 'package.json'))) throw new Error('没有找到 Harness 桌面版配置，请先启动并完成 Harness 的初始设置');
  const file = path.join(profile, 'cordis.patch.yml');
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const begin = previous.indexOf(START), end = previous.indexOf(END);
  if ((begin >= 0) !== (end >= 0) || (begin >= 0 && end < begin)) throw new Error('发现不完整的旧桥接配置，请保留原文件并检查');
  let clean = begin < 0 ? previous : previous.slice(0, begin) + previous.slice(end + END.length).replace(/^\r?\n/, '');
  // Earlier desk installers wrote an unmarked one-plugin insert. Remove only
  // that owned entry so a relocation cannot keep importing the old C: path.
  clean = clean.replace(/^- insert:[ \t]*\r?\n(?:(?:[ \t]+[^\r\n]*|)[\r]?\n)*/gm, block => {
    const ids = [...block.matchAll(/^[ \t]{4}- id:[ \t]*([^\r\n]+)/gm)].map(m => m[1].trim());
    return ids.length === 1 && ids[0] === 'shared-ai-desk-bridge' ? '' : block;
  });
  let next = clean;
  if (!remove) {
    const configFile = path.join(appRoot, 'data', 'config.json');
    const config = validateConfig(loadJson(configFile, DEFAULTS));
    config.harnessToken ||= crypto.randomBytes(32).toString('hex'); config.deepseekBackend = 'harness'; atomicWrite(configFile, config);
    const moduleUrl = pathToFileURL(path.join(appRoot, 'harness-plugin.mjs')).href + '?v=3';
    const block = `${START}\n- insert:\n    - id: shared-ai-desk-bridge\n      name: ${JSON.stringify(moduleUrl)}\n      config:\n        configFile: ${JSON.stringify(configFile.replaceAll('\\', '/'))}\n${END}\n`;
    const meaningful = clean.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n').trim();
    if (meaningful === '[]') clean = clean.replace(/^\s*\[\]\s*$/m, '');
    next = clean.trimEnd() + '\n\n' + block;
  }
  if (next === previous) return { changed: false, file, detail: '桥接配置已是所需状态。' };
  const backup = path.join(appRoot, 'data', 'harness-profile-backup.yml');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, previous, { mode: 0o600 });
  // Change only this marked block and preserve every other profile setting.
  fs.writeFileSync(file, next, { mode: 0o600 });
  return { changed: true, file, backup, detail: remove ? '已移除一体双魂桥接配置，其他 Harness 设置保留。' : '已接入 Harness 桌面版。若连接检查仍不通过，请在空闲时关闭并重新打开 Harness；无需重新登录或填写模型密钥。' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(installHarness({ remove: process.argv.includes('--remove') }).detail); }
  catch (error) { console.error('无法修改 Harness 配置：' + error.message); process.exitCode = 1; }
}
