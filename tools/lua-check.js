#!/usr/bin/env node
/**
 * StockTake Lua 语法校验器（M4 工具）
 * 用法:
 *   node lua-check.js <文件或目录> [更多路径...]
 * 退出码: 0 = 全部通过; 1 = 存在语法错误
 */
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');

const WOW_LUA = '5.1';

// 扫描时跳过的目录：node_modules 里的 fengari 自带 4 个 .lua 测试文件，会污染计数
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.scratch', 'reports']);

function collect(targets) {
  const out = [];
  for (const t of targets) {
    let st;
    try { st = fs.statSync(t); } catch { out.push({ file: t, missing: true }); continue; }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(t, { withFileTypes: true })) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        const p = path.join(t, e.name);
        if (e.isDirectory()) out.push(...collect([p]));
        else if (e.name.toLowerCase().endsWith('.lua')) out.push({ file: p });
      }
    } else out.push({ file: t });
  }
  return out;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('用法: node lua-check.js <文件或目录> [...]');
  process.exit(2);
}

const files = collect(targets);
let ok = 0, failed = 0, missing = 0;
const failures = [];

for (const { file, missing: miss } of files) {
  if (miss) { missing++; failures.push({ file, error: '文件不存在' }); continue; }
  let src;
  try { src = fs.readFileSync(file, 'utf8'); }
  catch (e) { failed++; failures.push({ file, error: '读取失败: ' + e.message }); continue; }

  // UTF-8 BOM 与 CRLF 是 WoW 可接受的，但 BOM 会污染首行 (local ... = ...)，在此提示
  const hasBOM = src.charCodeAt(0) === 0xFEFF;
  const body = hasBOM ? src.slice(1) : src;

  try {
    luaparse.parse(body, { luaVersion: WOW_LUA, comments: false, scope: false, locations: true });
    ok++;
    if (hasBOM) console.log(`  [warn] ${file} 含 UTF-8 BOM（建议另存为无 BOM）`);
  } catch (e) {
    failed++;
    failures.push({ file, error: `L${e.line}:${e.column} ${e.message}` });
  }
}

console.log(`\n语法校验: ${ok} 通过 / ${failed} 失败 / ${missing} 缺失（共 ${files.length} 个 .lua）`);
if (failures.length) {
  console.log('\n失败明细:');
  for (const f of failures) console.log(`  ✗ ${f.file}\n      ${f.error}`);
}
process.exit(failed || missing ? 1 : 0);
