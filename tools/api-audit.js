#!/usr/bin/env node
/**
 * StockTake API 契约审计器（M4 工具）
 * 校验规划第三章"已冻结 API 事实"是否被遵守，扫描违规用法。
 * 用法: node api-audit.js <目录或文件> [...]
 * 退出码: 0 = 无 ERROR; 1 = 存在 ERROR
 */
const fs = require('fs');
const path = require('path');

const RULES = [
  // [级别, 正则, 说明]
  ['ERROR', /(?<![\w.:])GetItemCount\s*\(/g,
    '使用了已弃用的全局 GetItemCount（10.2.6 弃用 / 12.1.5 移除兜底）→ 必须改用 C_Item.GetItemCount'],
  ['ERROR', /(?<![\w.:])GetContainerItemInfo\s*\(/g,
    '使用了全局 GetContainerItemInfo → 必须改用 C_Container.GetContainerItemInfo'],
  ['ERROR', /(?<![\w.:])GetContainerNumSlots\s*\(/g,
    '使用了全局 GetContainerNumSlots → 必须改用 C_Container.GetContainerNumSlots'],
  ['ERROR', /GetContainerItemLink\s*\(/g,
    '使用了全局 GetContainerItemLink → 必须改用 C_Container.GetContainerItemLink'],
  ['ERROR', /hyperlink[^\n]{0,120}?match\s*\(/g,
    '解析 hyperlink 取物品名 → 12.x 应直接用 ContainerItemInfo.itemName'],
  ['WARN', /(?:GetContainerNumSlots|GetContainerItemInfo|GetContainerItemLink|GetContainerNumFreeSlots|GetContainerItemID)\s*\(\s*-\s*[1-9]/g,
    '向容器 API 传入裸负数 ID → 应使用 Enum.BagIndex 命名成员（Keyring/CharacterBankTab/AccountBankTab/BankBag）',
    /Scanner_(Bank|Warband|Bags|Equip)\.lua$/],
  ['WARN', /\bC_Timer\.After\s*\(\s*0?\.5/g,
    '使用 0.5s 盲等 → 契约 §1 要求 SL:Debounce 事件驱动（0.2s 合并窗口）'],
  ['WARN', /\bGetItemInfo\s*\(/g,
    'GetItemInfo 可能返回 nil，需容错'],
];

// 允许清单：路径包含这些片段的文件跳过对应规则（如 diag 自检允许调用 C_Item.GetItemCount）
const ALLOW = [
  { file: /Diag|Core\.lua|Counter\.lua/i, rule: /GetItemCount/ },
];
// 扫描时跳过的目录：node_modules 里的 fengari 自带 4 个 .lua 测试文件，会污染计数
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.scratch', 'reports']);
function collect(targets, acc = []) {
  for (const t of targets) {
    let st; try { st = fs.statSync(t); } catch { continue; }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(t, { withFileTypes: true })) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        collect([path.join(t, e.name)], acc);
      }
    }
    else if (t.toLowerCase().endsWith('.lua')) acc.push(t);
  }
  return acc;
}

const files = collect(process.argv.slice(2));
if (!files.length) { console.error('未找到 .lua 文件'); process.exit(2); }

let errors = 0, warns = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  for (const [level, re, msg] of RULES) {
    if (ALLOW.some(a => a.file.test(file) && a.rule.test(msg))) continue;
    re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      // 裸负数规则对注释行降噪
      if (/^\s*--/.test(lines[i])) continue;
      const tag = level === 'ERROR' ? '✗ ERROR' : '⚠ WARN ';
      console.log(`${tag} ${path.basename(file)}:${i + 1}  ${msg}`);
      console.log(`         > ${lines[i].trim().slice(0, 120)}`);
      if (level === 'ERROR') errors++; else warns++;
    }
  }
}

console.log(`\nAPI 审计: ${files.length} 个文件, ${errors} 个 ERROR, ${warns} 个 WARN`);
process.exit(errors ? 1 : 0);
