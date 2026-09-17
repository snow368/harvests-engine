#!/usr/bin/env node
/**
 * 闸门：pm2 托管的脚本里，所有子进程调用必须隐藏窗口（windowsHide: true）
 * ================================================================
 * 背景（2026-09-17 实锤）：
 *   Windows 上 node 的 child_process 默认 `windowsHide: false`。当父进程本身
 *   没有可用控制台（pm2 daemon 就是这种）时，Windows 会给每个 console 子系统
 *   子进程（python.exe / cmd.exe / pm2.cmd …）**新分配一个可见控制台窗口**。
 *   于是「每 10s 调一次 pm2 jlist」= 每 10s 弹一个黑窗，用户体感「老是有弹窗」。
 *
 *   注意：pm2 **自己**拉起 app 时是隐藏窗口的（ForkMode.js 默认 windowsHide: true），
 *   所以弹窗责任 100% 在 app 内部的 spawn/exec，不在 pm2 的重启。
 *   ⇒ 这条闸门只检查 pm2 托管的脚本，防止以后再引入同类弹窗。
 *
 * 用法：node scripts/check-windows-hide.mjs       （发现违规 → exit 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ECO = path.join(ROOT, 'ecosystem.config.cjs');

// 1. 从 ecosystem 取出所有被托管的脚本（= 会以「无控制台」身份运行的进程）
const eco = fs.readFileSync(ECO, 'utf8');
const managed = [...new Set([...eco.matchAll(/script:\s*'([^']+)'/g)].map((m) => m[1]))];

const CALL_RE = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/g;
const violations = [];
let checked = 0;

for (const rel of managed) {
  const file = path.join(ROOT, rel.replace(/^\.\//, ''));
  if (!fs.existsSync(file)) {
    violations.push({ file: rel, line: 0, msg: '脚本不存在' });
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');

  // 2. 找出「值是含 windowsHide 的对象字面量」的常量名（如 EXEC_OPTS）
  const hideConsts = new Set(
    [...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^}]*windowsHide[^}]*\}/g)].map((m) => m[1])
  );

  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(src)) !== null) {
    // 排除 `regex.exec(...)` 这类同名的正则方法调用
    const before = src.slice(Math.max(0, m.index - 1), m.index);
    if (m[1] === 'exec' && before === '.') continue;

    checked++;
    const window = src.slice(m.index, m.index + 500);
    if (window.includes('windowsHide')) continue;
    if ([...hideConsts].some((c) => window.includes(c))) continue;

    const line = src.slice(0, m.index).split('\n').length;
    const snippet = src.split('\n')[line - 1].trim().slice(0, 120);
    violations.push({ file: rel, line, msg: snippet });
  }
}

console.log(`[check-windows-hide] 托管脚本 ${managed.length} 个，子进程调用点 ${checked} 个`);
if (violations.length === 0) {
  console.log('✅ 全部带 windowsHide —— 不会弹控制台窗口');
  process.exit(0);
}
console.error(`❌ ${violations.length} 个调用点缺 windowsHide（会弹控制台窗口）：`);
for (const v of violations) console.error(`   ${v.file}:${v.line}  ${v.msg}`);
console.error('   修法：spawn/exec/execSync 的 options 里加 `windowsHide: true`（或复用含它的常量）。');
process.exit(1);
