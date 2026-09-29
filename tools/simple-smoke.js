#!/usr/bin/env node
/**
 * simple-smoke.js —— StockTake 简化版（0.2.0）无头冒烟测试
 *
 * 用法：node simple-smoke.js [addonRoot]（默认 = 本仓库根目录）
 * 退出码：0 = 全部通过；1 = 存在失败；2 = 加载失败
 *
 * 说明：老的 smoke-test.js 针对已归档的复杂版 v0.1.0（契约 §2-§11），
 *       本文件针对当前简化版（5 文件），是当前版本的权威关卡。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createWowMock, measureText } = require('./wow-mock.js');

const ADDON_NAME = 'StockTake';
const ROOT = path.normalize(
  process.argv[2] || path.join(__dirname, '..')
);
const TOC = path.join(ROOT, 'StockTake.toc');

/* ── 断言框架 ───────────────────────────────────────────────────── */
let total = 0, passed = 0;
const failures = [];
function eq(actual, expected, msg) {
  total++;
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) passed++;
  else failures.push(`${msg}\n      期望=${b}  实际=${a}`);
}
function ok(value, msg) {
  total++;
  if (value) passed++;
  else failures.push(msg);
}

/* ── 载入 ───────────────────────────────────────────────────────── */
function parseToc(p) {
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/\\/g, '/'));
}

const tocFiles = parseToc(TOC);

// 场景隔离拷贝：SCENARIO 是模块级共享对象，若不拷贝，某个测试对容器的改动
//（如 setContainer(0, [])）会泄漏到后续测试，造成"登录扫描无数据"之类的串扰。
function cloneScenario(sc) {
  const out = Object.assign({}, sc);
  out.containers = {};
  for (const k of Object.keys(sc.containers || {})) out.containers[k] = (sc.containers[k] || []).slice();
  if (sc.containerSlots) out.containerSlots = Object.assign({}, sc.containerSlots);
  out.bankTabIDs = {};
  for (const k of Object.keys(sc.bankTabIDs || {})) out.bankTabIDs[k] = (sc.bankTabIDs[k] || []).slice();
  // 逐 itemID / 逐装备槽的映射同样要各自一份：setItemCount / setEquipped 等 setter
  // 是**直接写入这些对象**的，浅拷贝会让改动泄漏到后续用例
  //（此前只防了容器与银行页，装备与计数表是新增的串扰面）。
  for (const key of ['equip', 'itemMeta', 'itemCount', 'itemCountBank', 'itemCountReagent', 'itemCountAccount']) {
    out[key] = Object.assign({}, sc[key]);
  }
  if (sc.savedVars && typeof sc.savedVars === 'object') out.savedVars = {};   // 每次全新，防跨测试串扰
  return out;
}

function load(scenario) {
  const sc = scenario ? cloneScenario(scenario) : undefined;
  const mock = createWowMock(sc ? { scenario: sc } : {});
  // savedVars 为 null 时保持 SL2_DB = nil（模拟首次安装），其余情况注入
  mock.setGlobal('SL2_DB', (sc && sc.savedVars !== undefined) ? sc.savedVars : {});
  const addonRef = mock.makeAddonTable(ADDON_NAME);
  const loaded = [];
  for (const rel of tocFiles) {
    const fp = path.join(ROOT, rel);
    if (!fs.existsSync(fp)) {
      loaded.push({ rel, ok: false, error: '文件缺失' });
      continue;
    }
    const r = mock.loadFile(fp, '@' + rel, ADDON_NAME, addonRef);
    loaded.push({ rel, ok: r.ok, error: r.error });
  }
  return { mock, loaded };
}

function lifecycle(mock) {
  mock.fireEvent('ADDON_LOADED', ADDON_NAME);
  mock.fireEvent('PLAYER_ENTERING_WORLD', true, false);
}

function it(itemID, stackCount) {
  return { itemID, stackCount: stackCount || 1, itemName: 'Item' + itemID, iconFileID: 1, quality: 1 };
}

// 读某个 tooltip 上已追加的行：合并左右两列（右列承载明细，v0.9 起为固定像素列）
function readLines(mock, name) {
  const byIndex = {};
  const collect = (side) => {
    const re = new RegExp('^' + name + side + '(\\d+)$');
    for (const id of Object.keys(mock.frames)) {
      const f = mock.frames[id];
      if (!f || !f.name) continue;
      const m = re.exec(f.name);
      if (m) {
        const n = parseInt(m[1], 10);
        byIndex[n] = byIndex[n] || {};
        byIndex[n][side] = f;
      }
    }
  };
  collect('TextLeft');
  collect('TextRight');
  return Object.keys(byIndex)
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => {
      const left = byIndex[n].TextLeft;
      const right = byIndex[n].TextRight;
      const text = (left && left.text != null ? String(left.text) : '')
        + (right && right.text != null ? String(right.text) : '');
      return { n, text, font: left && left.font, left: left && left.text, right: right && right.text };
    });
}

const SCENARIO = {
  locale: 'zhCN',                  // GetLocale() → 中文词条
  clock: 0,
  containers: {
    0: [it(100, 3), it(200, 2)],   // 背包
    5: [it(300, 4)],               // 材料包
    6: [it(500, 2)],               // 银行页 1
    7: [it(500, 3)],               // 银行页 2
    '-4': [],                      // 银行包栏（真实客户端恒有 7 个槽位）
  },
  containerSlots: { '-4': 7 },     // 声明容量：空容器 ≠ 不可读（装置按容量而非条目数报告槽位）
  bankTabIDs: { 0: [6, 7] },       // Character 银行已购页
  equip: {},
  savedVars: {},
};

// 其他角色的数据用 Lua 侧注入：保证 itemID 是数字键（JS→Lua 的键会变成字符串）。
// 前置守卫使其可在 lifecycle 之前调用——模拟"SavedVariables 里已存在的历史角色"
//（ADDON_LOADED 只补缺失结构，不会清掉已有 chars）。
function seedAlts(mock) {
  mock.runLuaCode(
    'if type(SL2_DB) ~= "table" then SL2_DB = {} end\n' +
    'if type(SL2_DB.chars) ~= "table" then SL2_DB.chars = {} end\n' +
    'SL2_DB.chars["TestRealm-AltOne"] = { name = "AltOne", class = "MAGE", bags = { [100] = 5 }, bank = { [100] = 1 } }\n' +
    'SL2_DB.chars["TestRealm-AltTwo"] = { name = "AltTwo", class = "WARRIOR", bags = { [100] = 2 }, bank = {} }'
  );
}

/* ── 1. 文件与加载 ──────────────────────────────────────────────── */
console.log('StockTake 简化版冒烟测试\n');
eq(tocFiles.length, 5, '1) .toc 恰好列出 5 个文件');
{
  const { loaded } = load(SCENARIO);
  const bad = loaded.filter((l) => !l.ok);
  ok(bad.length === 0, '1) 5 个文件全部存在且加载成功（失败: ' + JSON.stringify(bad) + '）');
}

/* ── 2. DB 与配置 ───────────────────────────────────────────────── */
{
  const { mock } = load(SCENARIO);
  mock.fireEvent('ADDON_LOADED', ADDON_NAME);
  const db = mock.getGlobal('SL2_DB');
  eq(db.version, 2, '2) SL2_DB.version = 2');
  ok(db.chars && typeof db.chars === 'object', '2) SL2_DB.chars 已建立');
  eq(db.options.fontSize, 0, '2) 默认字号 0 = 跟随游戏（不干预提示框字体）');
  eq(db.options.showTotal, true, '2) 默认显示合计行');
  eq(Object.keys(db.options).length, 2, '2) 配置项恰好 2 个（enabled / showOthers 均已移除）');
  ok(db.options.enabled === undefined, '2) 已移除 enabled 配置键');
  ok(db.options.showOthers === undefined, '2) 已移除 showOthers（与「显示哪些角色」重复）');
}

/* ── 3. 登录与扫描（背包 / 银行） ───────────────────────────────── */
{
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  const key = mock.evalLua('return StockTake.player.key').value;
  eq(key, 'TestRealm-TestChar', '3) 角色键 = 服务器-角色名');

  // 注意：getGlobal 返回的是快照，事件之后必须重新取，否则读到旧值
  const bagsOf = (k) => mock.getGlobal('SL2_DB').chars[k].bags;
  const bankOf = (k) => mock.getGlobal('SL2_DB').chars[k].bank;

  eq(bagsOf(key)['100'], 3, '3) 登录时记录背包：item100 = 3');
  eq(bagsOf(key)['200'], 2, '3) 登录时记录背包：item200 = 2');
  eq(bagsOf(key)['300'], 4, '3) 材料包（容器 5）计入背包：item300 = 4');
  ok(bankOf(key)['500'] === undefined, '3) 未开银行时不写银行数据');

  // 打开银行 → 去抖 0.5s 后扫描
  mock.fireEvent('BANKFRAME_OPENED');
  mock.advanceTime(0.6);
  eq(bankOf(key)['500'], 5, '3) 打开银行后记录银行：item500 = 2+3（跨页求和）');

  // 所有容器都读不到（登录瞬间）→ 保留上轮数据
  mock.setContainer(0, []);
  mock.setContainer(5, []);
  mock.fireEvent('BAG_UPDATE_DELAYED');
  mock.advanceTime(0.3);
  eq(bagsOf(key)['100'], 3, '3) 容器未加载时不写空表（保留上轮数据）');
}

/* ── 4. 提示框渲染 ──────────────────────────────────────────────── */
function renderWith(itemID, opts) {
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  // C_Item.GetItemCount：背包 + 银行（includeBank）+ 战团（includeAccountBank）
  mock.setItemCount(itemID, opts.bags || 0);
  mock.setItemCountBank(itemID, opts.bank || 0);
  mock.setItemCountAccount(itemID, opts.account || 0);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: itemID });
  return { mock, lines: readLines(mock, 'GameTooltip') };
}

{
  // 本角色：背包 2；银行 3（角色）+ 战团 4 = 7；总 9
  // 其他角色：AltOne 5+1=6；AltTwo 2+0=2
  const { lines } = renderWith(100, { bags: 2, bank: 3, account: 4 });
  const texts = lines.map((l) => l.text);
  // 布局：空行 + 3 个角色行 + 合计行 + 空行 = 6 行
  ok(texts.length === 6, '4) 渲染 空行+3 角色行+合计行+空行 = 6 行（实际 ' + texts.length + '）');
  ok(texts[0].trim() === '', '4) 首行是空白行（与上方游戏内容隔开）');
  ok(texts[texts.length - 1].trim() === '', '4) 末行是空白行（与下方内容隔开）');
  ok(texts[1].indexOf('TestChar') !== -1, '4) 空行之后第一行是当前角色');
  ok(texts[1].indexOf('9') !== -1, '4) 当前角色总数 = 2+3+4 = 9（战团并入银行）');
  ok(texts[1].indexOf('背 2') !== -1, '4) 当前角色背包显示 2');
  ok(texts[1].indexOf('银 7') !== -1, '4) 当前角色银行 = 3+4 = 7（战团并入「银」，无「战团」字样）');
  ok(texts[1].indexOf('战团') === -1, '4) 提示框里不出现「战团」分类');
  ok(texts[2].indexOf('AltOne') !== -1 && texts[2].indexOf('6') !== -1, '4) 其他角色行按数量降序（AltOne 6）');
  ok(texts[3].indexOf('AltTwo') !== -1 && texts[3].indexOf('2') !== -1, '4) AltTwo 2');
  ok(/合计/.test(texts[4]) && texts[4].indexOf('17') !== -1, '4) 合计行 = 9+6+2 = 17');
  // 默认 0 = 跟随游戏：不应改动任何行的字号（装置默认字高 12）
  const touched = lines.filter((l) => l.font && l.font.height !== 12);
  ok(touched.length === 0, `4) 默认「跟随游戏」时零改动（异常 ${touched.length} 行）`);
}

/* ── 4b. 兜底路径：AddLine 不返回 FontString 时也要覆盖所有行 ────── */
{
  const sc = Object.assign({}, SCENARIO, { addLineNoReturn: true });
  const { mock } = load(sc);
  lifecycle(mock);
  seedAlts(mock);
  mock.evalLua('StockTake:Set("fontSize", 20)');
  mock.setItemCount(100, 2);
  mock.setItemCountBank(100, 3);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  const lines = readLines(mock, 'GameTooltip');
  ok(lines.length >= 4, `4b) AddLine 无返回值时仍渲染出 ${lines.length} 行`);
  const bad = lines.filter((l) => !l.font || l.font.height !== 20);
  ok(bad.length === 0, `4b) 按行号兜底：全部 ${lines.length} 行都拿到字号 20（异常 ${bad.length} 行）`);
}

/* ── 4d. 当前角色名下的红色下划线 ───────────────────────────────── */
{
  const { mock, lines } = renderWith(100, { bags: 2, bank: 0, account: 0 });
  const texs = Object.values(mock.frames).filter(
    (f) => f.kind === 'texture' && f.parent === mock.gameTooltip
  );
  ok(texs.length === 1, `4d) 提示框上创建了 1 条下划线纹理（实际 ${texs.length}）`);
  ok(texs.length === 1 && texs[0].shown === true, '4d) 下划线处于显示状态');
  const colorCall = (mock.calls || []).find((c) => c.scope === 'region' && c.method === 'SetColorTexture');
  ok(colorCall != null, '4d) 调用了 SetColorTexture');
  if (colorCall) {
    const r = colorCall.args[0], g = colorCall.args[1], b = colorCall.args[2];
    ok(r === 1 && g < 0.3 && b < 0.3, `4d) 颜色为红色（实际 ${r},${g},${b}）`);
  }
  ok(lines.length === 6, `4d) 版式 = 空行 + 3 角色行（自己+2 个其他角色）+ 合计行 + 空行（实际 ${lines.length}）`);
  ok(lines[1].text.indexOf('TestChar') !== -1, '4d) 下划线锚定的那一行是当前角色（第 2 行）');
}
{
  // 这件物品谁都没有（含自己也没）→ 不渲染任何行，下划线必须隐藏
  const { mock, lines } = renderWith(999, { bags: 0, bank: 0, account: 0 });
  ok(lines.length === 0, `4d) 一件都没有时不渲染任何行（实际 ${lines.length}）`);
  const texs = Object.values(mock.frames).filter(
    (f) => f.kind === 'texture' && f.parent === mock.gameTooltip
  );
  ok(texs.every((f) => f.shown === false), '4d) 无数据时不显示下划线');
}

/* ── 4e. 插入位置：数量块必须在**原生内容之后**、其他插件之前 ────── */
{
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  mock.setItemCount(100, 2);
  mock.setItemCountBank(100, 3);
  mock.setItemCountAccount(100, 4);

  // 模拟客户端完整流程：tooltipPreCall → 逐行[加行+linePostCall] → tooltipPostCall
  const lines = mock.invokeItemTooltipFlow(mock.gameTooltip, { id: 100 }, [
    { type: 'ItemName', text: '|cff1eff00|Hitem:100|h[测试物品]|h|r' },
    { type: 'ItemLevel', text: '物品等级 350' },
    { type: 'ItemBinding', text: '拾取后绑定' },
  ]);

  // 期望：3 行原生内容 → 空行 → 当前角色 → 其他角色 → 合计 → 空行
  ok(lines[0].indexOf('测试物品') !== -1, '4e) 第 1 行是物品名');
  ok(lines[1] === '物品等级 350', '4e) 第 2 行是原生内容（等级）');
  ok(lines[2] === '拾取后绑定', '4e) 第 3 行是原生内容（绑定）');
  ok(lines[3].trim() === '', '4e) 第 4 行是空行 —— 数量块紧跟在原生内容之后');
  ok(lines[4].indexOf('TestChar') !== -1, '4e) 第 5 行是当前角色');
  ok(lines[5].indexOf('AltOne') !== -1, '4e) 第 6 行是其他角色（按数量降序）');
  ok(lines[6].indexOf('AltTwo') !== -1, '4e) 第 7 行是第二个其他角色');
  ok(/合计/.test(lines[7]), '4e) 第 8 行是合计行');
  ok(lines[8].trim() === '', '4e) 第 9 行是空行');
  ok(lines.length === 9, `4e) 总行数 = 3 原生行 + 6 块行 = 9（实际 ${lines.length}）`);
  ok(lines.filter((t) => /合计/.test(t)).length === 1, '4e) 合计行只有一份（兜底路径没有重复插入）');

  const texs = Object.values(mock.frames).filter(
    (f) => f.kind === 'texture' && f.parent === mock.gameTooltip
  );
  ok(texs.length === 1 && texs[0].shown === true, '4e) 下划线仍被创建并显示');
}

/* ── 4c. 全局生效：连游戏自带的行（PostCall 之前就存在的行）也必须变 ── */
{
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  mock.evalLua('StockTake:Set("fontSize", 18)');
  mock.runLuaCode('GameTooltip:AddLine("觉醒之焰")');   // 模拟游戏自己加的物品名行
  mock.setItemCount(100, 1);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  const lines = readLines(mock, 'GameTooltip');
  const first = lines[0];
  ok(first && first.text === '觉醒之焰', '4c) 模拟的游戏自带行存在');
  ok(first && first.font && first.font.height === 18, '4c) 游戏自带的行也被设为全局字号 18');
  const bad = lines.filter((l) => !l.font || l.font.height !== 18);
  ok(bad.length === 0, `4c) 全部 ${lines.length} 行统一为 18（异常 ${bad.length} 行）`);
}

/* ── 5. 开关与字号 ──────────────────────────────────────────────── */
{
  // 字号改 20
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  mock.evalLua('StockTake:Set("fontSize", 20)');
  mock.setItemCount(100, 1);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  const lines = readLines(mock, 'GameTooltip');
  const bad = lines.filter((l) => !l.font || l.font.height !== 20);
  ok(lines.length >= 3, `5) 渲染 ${lines.length} 行`);
  ok(bad.length === 0, `5) 字号改为 20 后**所有行**立即生效（异常 ${bad.length} 行）`);
}
{
  // 关闭合计行
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  mock.evalLua('StockTake:Set("showTotal", false)');
  mock.setItemCount(100, 1);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  const texts = readLines(mock, 'GameTooltip').map((l) => l.text);
  ok(!texts.some((t) => /合计/.test(t)), '5) showTotal=false 时无合计行');
}
{
  // 0.9.4：移除"显示其他角色"总开关后，逐角色勾选列表成为唯一控制
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  eq(mock.evalLua('return tostring(StockTake.DEFAULTS.showOthers)').value, 'nil', '5) DEFAULTS 中已无 showOthers');
  mock.evalLua('StockTake:SetCharHidden("TestRealm-AltOne", true) StockTake:SetCharHidden("TestRealm-AltTwo", true)');
  mock.setItemCount(100, 1);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  const texts = readLines(mock, 'GameTooltip').map((l) => l.text);
  ok(texts.some((t) => /TestChar/.test(t)), '5) 取消全部其他角色后当前角色仍在');
  ok(!texts.some((t) => /AltOne|AltTwo/.test(t)), '5) 全部取消勾选 = 只看自己（取代已移除的 showOthers）');
}
{
  // 已移除"启用插件"总开关：默认一定渲染，且配置里不再有 enabled
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  mock.setItemCount(100, 1);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  ok(readLines(mock, 'GameTooltip').length > 0, '5) 无总开关：默认即渲染');
  eq(mock.evalLua('return tostring(StockTake.DEFAULTS.enabled)').value, 'nil', '5) DEFAULTS 中已无 enabled');
}

/* ── 4f. 多角色时括号必须对齐（固定像素列，结构断言）────────────── */
{
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  // 四个角色，数量位数各不相同：5 / 3 / 12 / 27
  mock.runLuaCode(
    'SL2_DB.chars["R-A"] = { name = "霜火之誓", class = "MAGE", bags = { [100] = 3 }, bank = {} }\n' +
    'SL2_DB.chars["R-B"] = { name = "铁炉守卫", class = "WARRIOR", bags = { [100] = 12 }, bank = {} }\n' +
    'SL2_DB.chars["R-C"] = { name = "Ironforge", class = "PRIEST", bags = { [100] = 27 }, bank = {} }'
  );
  mock.setItemCount(100, 5);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });

  // 1) 每行右列存在且带括号明细
  const rows = readLines(mock, 'GameTooltip').filter((l) => l.right && /（/.test(l.right));
  ok(rows.length === 4, `4f) 4 行有右列明细（实际 ${rows.length}）`);

  // 2) 结构断言：所有右列被重新锚定到**同一个 x 偏移**（固定像素列 = 完全对齐）
  const anchors = (mock.calls || [])
    .filter((c) => c.scope === 'region' && c.method === 'SetPoint'
      && /^GameTooltipTextRight\d+$/.test(c.frame || ''))
    .map((c) => c.args && c.args[3]);                     // [point, relativeTo, relativePoint, x, y]
  ok(anchors.length >= 4, `4f) 4 个右列都被重锚定（实际 ${anchors.length}）`);
  const uniq = [...new Set(anchors.map((x) => String(x)))];
  ok(uniq.length === 1, `4f) 所有右列 x 偏移一致（${anchors.join(', ')}）`);
  ok(Number(anchors[0]) > 0, `4f) 列位置在正偏移处（x = ${anchors[0]}）`);

  // 3) 左列只含"名字: 总数"，不再有补空格
  ok(rows.every((l) => /^[\|c0-9a-fA-F]*\|?r?[^：]*: \d+$/.test(String(l.left).replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '')) || !/ {5,}/.test(String(l.left))),
     '4f) 左列不再用空格补白（对齐不再依赖字符宽度）');
}

/* ── 7. 英文版本（locale = enUS）──────────────────────────────── */
{
  const sc = Object.assign({}, SCENARIO, { locale: 'enUS' });
  const { mock } = load(sc);
  lifecycle(mock);
  seedAlts(mock);
  mock.setItemCount(100, 2);
  mock.setItemCountBank(100, 3);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  const texts = readLines(mock, 'GameTooltip')
    .map((l) => l.text)
    .filter((t) => t.trim() !== '');
  ok(texts.some((t) => /\(bags 2 · bank 3\)/.test(t)), '7) 英文环境：明细写作 (bags 2 · bank 3)');
  ok(texts.some((t) => /^Total:/.test(t)), '7) 英文环境：合计行写作 Total:');
  ok(
    texts.some((t) => /TestChar/.test(t) && /: 5\s+\(bags 2 · bank 3\)/.test(t)),
    '7) 英文环境：当前角色行为 "TestChar: 5  (bags 2 · bank 3)"（括号前留白）'
  );
  ok(!texts.some((t) => /[背银合计（）]/.test(t)), '7) 英文环境不出现中文字样/全角括号');
}

/* ── 7b. 两套词条键集合必须完全一致 ───────────────────────────── */
{
  const keysOf = (which) => {
    const { mock } = load(Object.assign({}, SCENARIO, { locale: 'zhCN' }));
    return mock.evalLua(
      'local t = {} for k in pairs(StockTake.localeTables.' + which +
      ') do t[#t + 1] = k end table.sort(t) return table.concat(t, ",")'
    ).value;
  };
  const cn = keysOf('zhCN');
  const tw = keysOf('zhTW');
  const en = keysOf('enUS');
  eq(en, cn, '7b) enUS 与 zhCN 的词条键集合完全一致');
  eq(tw, cn, '7b) zhTW 与 zhCN 的词条键集合完全一致（三语同键）');
  // 0.9.4：SHOW_OTHERS / SHOW_OTHERS_TIP 随复选框一起移除；0.9.5 增 MSG_LOCALE_TW，故下限 19
  ok(String(cn).split(',').length >= 19, `7b) 词条数量 = ${String(cn).split(',').length}`);
  // 更名回归 + 三语显示名
  const titleOf = (locale) => load(Object.assign({}, SCENARIO, { locale })).mock
    .evalLua('return StockTake.L.ADDON_TITLE').value;
  eq(titleOf('zhCN'), '数量盘点', '7b) zhCN 显示名 = 数量盘点');
  eq(titleOf('zhTW'), '數量盤點', '7b) zhTW 显示名 = 數量盤點');
  eq(titleOf('enUS'), 'StockTake', '7b) enUS 显示名 = StockTake');
  // 繁體用词与简体有别（不是简繁直转）：设定/字型/帳號/戰隊/紀錄/記憶體…
  const twOf = (key) => load(Object.assign({}, SCENARIO, { locale: 'zhTW' })).mock
    .evalLua('return StockTake.L.' + key).value;
  eq(twOf('SHOW_TOTAL'), '顯示合計列', '7b) zhTW：行→列（繁體習慣）');
  ok(twOf('FONT_SIZE').indexOf('字型') !== -1, '7b) zhTW：字体→字型');
  ok(twOf('FONT_SIZE_TIP').indexOf('預設') !== -1, '7b) zhTW：默认→預設');
  ok(twOf('CHAR_SELECT_TIP').indexOf('登入') !== -1, '7b) zhTW：登录→登入');
  ok(twOf('CHAR_SELECT_TIP').indexOf('紀錄') !== -1, '7b) zhTW：记录→紀錄');
  ok(twOf('HINT').indexOf('指令') !== -1 && twOf('HINT').indexOf('開啟設定') !== -1, '7b) zhTW：命令→指令、打开设置→開啟設定');
  ok(twOf('CLEAN_DONE').indexOf('剩餘') !== -1 && twOf('CLEAN_DONE').indexOf('筆') !== -1, '7b) zhTW：剩余→剩餘、条→筆');
  ok(twOf('MSG_LOCALE_BAD').indexOf('儲存') !== -1, '7b) zhTW：保存→儲存');
}

/* ── 8. 语言预览开关（/sl en | /sl zh | /sl auto）──────────────── */
{
  const { mock } = load(SCENARIO);            // 客户端 zhCN
  lifecycle(mock);
  eq(mock.evalLua('return StockTake.L.BAGS').value, '背', '8) 中文客户端默认用中文');
  mock.invokeSlash('STOCKTAKE', 'en');
  eq(mock.evalLua('return StockTake.L.BAGS').value, 'bags', '8) /sl en 后提示框词条立即变英文');
  eq(mock.evalLua('return StockTake.L.TOTAL').value, 'Total', '8) 合计词条同步切换');
  eq(mock.evalLua('return StockTake.L.PAREN_LEFT').value, '     (', '8) 括号间距词条也切换（5 格 + 半角括号）');
  // 切到英文后渲染一次，确认提示框真的是英文
  seedAlts(mock);
  mock.setItemCount(100, 2);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  const enTexts = readLines(mock, 'GameTooltip').map((l) => l.text);
  ok(enTexts.some((t) => /\(bags 2\)/.test(t)), '8) /sl en 后渲染出英文明细');
  ok(!enTexts.some((t) => /[背银]/.test(t)), '8) /sl en 后不再出现中文分类名');

  mock.invokeSlash('STOCKTAKE', 'zh');
  eq(mock.evalLua('return StockTake.L.BAGS').value, '背', '8) /sl zh 切回中文');
  mock.invokeSlash('STOCKTAKE', 'auto');
  eq(mock.evalLua('return StockTake.L.BAGS').value, '背', '8) /sl auto 跟随客户端（zhCN → 中文）');
  eq(mock.evalLua('return StockTake:CurrentLocale()').value, 'zhCN', '8) CurrentLocale() 与客户端一致');

  // 0.9.5：三语 —— 繁體预览（/st tw）
  mock.invokeSlash('STOCKTAKE', 'tw');
  eq(mock.evalLua('return StockTake:Get("locale")').value, 'zhTW', '8) /st tw 存档语言 = zhTW');
  eq(mock.evalLua('return StockTake.L.SHOW_TOTAL').value, '顯示合計列', '8) /st tw 用繁體用詞（列）');
  eq(mock.evalLua('return StockTake.L.TOTAL').value, '合計', '8) /st tw 合计词条 = 合計');
  mock.invokeSlash('STOCKTAKE', 'zhtw');
  eq(mock.evalLua('return StockTake:CurrentLocale()').value, 'zhTW', '8) /st zhtw 别名同样生效');
  mock.invokeSlash('STOCKTAKE', 'zh');
  eq(mock.evalLua('return StockTake.L.SHOW_TOTAL').value, '显示合计行', '8) /st zh 切回简体');
}
{
  // 繁體客戶端：自动使用繁體词条，设置面板同样是繁體
  const { mock } = load(Object.assign({}, SCENARIO, { locale: 'zhTW' }));
  lifecycle(mock);
  eq(mock.evalLua('return StockTake:CurrentLocale()').value, 'zhTW', '8) 繁體客戶端 → zhTW');
  eq(mock.evalLua('return StockTake.L.ADDON_TITLE').value, '數量盤點', '8) 繁體客戶端显示名 = 數量盤點');
  const has = (s) => Object.values(mock.frames).some((f) => f.kind === 'fontstring' && String(f.text) === s);
  ok(has('顯示合計列'), '8) 繁體客戶端设置面板为繁體（顯示合計列）');
  ok(has('顯示哪些角色'), '8) 繁體客戶端角色区标题正确');
  ok(!has('显示合计行'), '8) 繁體客戶端不出现简体标签');
}
{
  // 英文客户端上预览中文
  const { mock } = load(Object.assign({}, SCENARIO, { locale: 'enUS' }));
  lifecycle(mock);
  eq(mock.evalLua('return StockTake.L.BAGS').value, 'bags', '8) 英文客户端默认用英文');
  mock.invokeSlash('STOCKTAKE', 'zh');
  eq(mock.evalLua('return StockTake.L.BAGS').value, '背', '8) 英文客户端上 /sl zh 可预览中文');
  mock.invokeSlash('STOCKTAKE', 'tw');
  eq(mock.evalLua('return StockTake.L.BAGS').value, '背', '8) 英文客户端上 /st tw 可预览繁體');
  eq(mock.evalLua('return StockTake.L.CLEAN_DONE').value.indexOf('筆') !== -1, true, '8) 繁體词条含繁體量詞「筆」');
  // 繁體也要真的画出来：明细用全角括号、「銀/合計」为繁体（此前只查过词条、没查过渲染）
  seedAlts(mock);
  mock.setItemCount(100, 7);
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  const twTexts = readLines(mock, 'GameTooltip').map((l) => l.text);
  ok(twTexts.some((t) => /（背 7/.test(t)), '8) /st tw 渲染出繁體明细（全角括号）');
  ok(twTexts.some((t) => t.indexOf('銀') !== -1), '8) /st tw 明细分类名为「銀」');
  ok(twTexts.some((t) => t.indexOf('合計') !== -1), '8) /st tw 合计行为「合計」');
}

/* ── 9. 审计加固回归：E1 残留 / ItemRef / 首次安装 / 银行部分加载 ── */
{
  // E1-a：物品流程被打断（只有 pre-call），同一提示框转显示单位内容；
  // 行回调的 lineIndex+类型与残留状态双巧合命中（最坏情况）→ 必须被 GetItem 主防线拦下
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  mock.setItemCount(100, 5);
  const sepType = mock.evalLua('return Enum.TooltipDataLineType.Separator').value;
  mock.invokeTooltipPreCall(1, mock.gameTooltip, { id: 100, lines: [{ type: sepType, leftText: 'x', lineIndex: 1 }] });
  mock.setTooltipItemLink(mock.gameTooltip, null);            // 单位提示框：GetItem → nil
  mock.invokeLinePostCall(sepType, mock.gameTooltip, { type: sepType, leftText: '生命值', lineIndex: 1 });
  const textsA = readLines(mock, 'GameTooltip').map((l) => l.text);
  ok(!textsA.some((t) => /TestChar/.test(t) || /（背/.test(t)), '9) E1：单位提示框行回调不插入数量块（GetItem 主防线）');

  // E1-b：同样的兜底判据命中，但 GetItem 确认是同一件物品 → 应当正常插入（防线不误伤）
  const b = load(SCENARIO);
  lifecycle(b.mock);
  seedAlts(b.mock);
  b.mock.setItemCount(100, 5);
  b.mock.setTooltipItemLink(b.mock.gameTooltip, 'item:100::::::::::::');
  b.mock.invokeTooltipPreCall(1, b.mock.gameTooltip, { id: 100, lines: [{ type: sepType, leftText: '原生', lineIndex: 1 }] });
  // 行回调传**另一个对象** → 引用判据失败，走 lineIndex+类型 兜底
  b.mock.invokeLinePostCall(sepType, b.mock.gameTooltip, { type: sepType, leftText: '原生', lineIndex: 1 });
  const textsB = readLines(b.mock, 'GameTooltip').map((l) => l.text);
  ok(textsB.some((t) => /TestChar/.test(t)), '9) E1：物品一致时兜底判据仍正常插入（防线不误伤）');
}
{
  // ItemRefTooltip（聊天链接）走兜底路径也应插入
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  mock.setItemCount(100, 5);
  mock.setTooltipItemLink(mock.itemRefTooltip, 'item:100::::::::::::');
  mock.invokeTooltipPostCall(1, mock.itemRefTooltip, { id: 100 });
  const texts = readLines(mock, 'ItemRefTooltip').map((l) => l.text);
  ok(texts.some((t) => /TestChar/.test(t)), '9) ItemRefTooltip 插入数量块（兜底路径）');
  ok(texts.some((t) => t.trim() === ''), '9) ItemRefTooltip 上下空白行齐备');
}
{
  // 首次安装：SL2_DB = nil，ADDON_LOADED 必须自建结构且不报错
  const { mock } = load(Object.assign({}, SCENARIO, { savedVars: null }));
  mock.fireEvent('ADDON_LOADED', ADDON_NAME);
  const db = mock.getGlobal('SL2_DB');
  ok(db && typeof db === 'object', '9) 首次安装：ADDON_LOADED 自建 SL2_DB');
  eq(db && db.version, 2, '9) 首次安装：version = 2');
  ok(db && typeof db.chars === 'object' && typeof db.options === 'object', '9) 首次安装：chars/options 结构齐备');
  mock.fireEvent('PLAYER_ENTERING_WORLD', true, false);
  eq(mock.evalLua('return StockTake.player.key').value, 'TestRealm-TestChar', '9) 首次安装：登录流程正常');
}
{
  // 银行部分加载：一页未加载时不得用半截数据覆盖上一轮完整记录
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  const key = mock.evalLua('return StockTake.player.key').value;
  const bankOf = () => mock.getGlobal('SL2_DB').chars[key].bank;
  mock.fireEvent('BANKFRAME_OPENED');
  mock.advanceTime(0.6);
  eq(bankOf()['500'], 5, '9) 完整扫描：item500 = 2+3');

  mock.setContainer(6, []);                    // 银行页 6 "未加载"（容量 0）
  mock.fireEvent('BANKFRAME_OPENED');
  mock.advanceTime(0.6);
  eq(bankOf()['500'], 5, '9) 部分加载：保留上一轮完整记录（不被半截数据覆盖）');

  mock.setContainer(6, [it(500, 9)]);          // 恢复可读 → 正常覆盖
  mock.fireEvent('BANKFRAME_OPENED');
  mock.advanceTime(0.6);
  eq(bankOf()['500'], 12, '9) 恢复完整：正常更新为 9+3');
}

/* ── 10. 角色筛选：隐藏的角色不出现在提示框 ─────────────────────── */
{
  // 用完整官方流程驱动（pre-call 会重置 inserted、OnShow 清 pending）。
  // 直调 post-call 的第二次调用会因 inserted=true 跳过插入——那是装置假象，不是游戏行为。
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  mock.setItemCount(100, 2);

  const renderFresh = () => {
    const before = mock.evalLua('return GameTooltip:NumLines()').value;
    mock.invokeItemTooltipFlow(mock.gameTooltip, { id: 100 }, [{ type: 'ItemName', text: '测试物品' }]);
    const after = mock.evalLua('return GameTooltip:NumLines()').value;
    const out = [];
    for (let i = before + 1; i <= after; i++) {
      const f = Object.values(mock.frames).find((x) => x.name === 'GameTooltipTextLeft' + i);
      if (f) out.push(String(f.text));
    }
    return out.join(' | ');
  };

  let text = renderFresh();
  ok(/AltOne/.test(text) && /AltTwo/.test(text) && /TestChar/.test(text), '10) 默认显示全部角色');

  mock.evalLua('StockTake:SetCharHidden("TestRealm-AltOne", true)');
  text = renderFresh();
  ok(!/AltOne/.test(text), '10) 隐藏后 AltOne 不再出现');
  ok(/AltTwo/.test(text) && /TestChar/.test(text), '10) 其他角色与当前角色不受影响');

  // 隐藏"当前角色"键 → 无效（自身恒显示）
  mock.evalLua('StockTake:SetCharHidden("TestRealm-TestChar", true)');
  text = renderFresh();
  ok(/TestChar/.test(text), '10) 当前角色不受 hiddenChars 影响（恒显示）');
  mock.evalLua('StockTake:SetCharHidden("TestRealm-TestChar", false)');

  mock.evalLua('StockTake:SetCharHidden("TestRealm-AltOne", false)');
  text = renderFresh();
  ok(/AltOne/.test(text), '10) 取消隐藏后恢复显示');
}
{
  // 设置面板（用例 A）：登录（PLAYER_READY）即自动构建角色区——不经 /sl、不调用 Open()。
  // 真实游戏里历史角色来自 SavedVariables：load() 注入 SL2_DB 后先 seedAlts 再 lifecycle
  // 是合法顺序（ADDON_LOADED 只补缺失结构，不清已有 chars）。
  const { mock } = load(SCENARIO);
  seedAlts(mock);                       // 必须在 lifecycle 之前：模拟已存在的存档角色
  lifecycle(mock);                      // PLAYER_ENTERING_WORLD 末尾 Fire PLAYER_READY → BuildCharSection
  ok(!mock.errors || mock.errors.length === 0,
     `10) 登录自动构建角色区无脚本错误（${JSON.stringify((mock.errors || [])[0] || '')}）`);
  const countChecks = (m) => Object.values(m.frames).filter(
    (f) => f.name && /^StockTakeOptCheck\d+$/.test(f.name)
  ).length;
  // 2 个基础勾选框 + 1 个自身（disabled）+ 2 个其他角色 = 5，全程未调用 Open()
  eq(countChecks(mock), 4, '10) 登录后（未调用 Open()）角色筛选区自动生成 1 基础 + 1 自身 + 2 其他 = 4 个勾选框');
  const labels = Object.values(mock.frames)
    .filter((f) => f.kind === 'fontstring' && f.text && /AltOne|AltTwo|TestChar/.test(String(f.text)))
    .map((f) => String(f.text));
  ok(labels.some((t) => /AltOne/.test(t)) && labels.some((t) => /AltTwo/.test(t)),
     '10) 历史角色（SavedVariables）出现在列表中');
  ok(labels.some((t) => /TestChar/.test(t) && /始终显示|always shown/.test(t)), '10) 自身标注"始终显示"');
  // 再显式 Open() 一次：幂等（charSectionBuilt 标志），勾选框数不变。
  // 注：Open() 内 Settings.OpenToCategory(category:GetID()) 在装置里会因桩 category 无 GetID
  // 报错，属装置假象（真实客户端分类对象有 GetID），不影响本断言。
  mock.evalLua('StockTake.Options:Open()');
  eq(countChecks(mock), 4, '10) Open() 对已构建的角色区幂等（勾选框数不变）');
}
{
  // 设置面板（用例 B）：全新存档（无其他角色）→ 登录后 1 基础 + 1 自身 = 2
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  const checks = Object.values(mock.frames).filter(
    (f) => f.name && /^StockTakeOptCheck\d+$/.test(f.name)
  );
  eq(checks.length, 2, '10) 无其他角色时登录自动生成 1 基础 + 1 自身 = 2 个勾选框');
  const labels = Object.values(mock.frames)
    .filter((f) => f.kind === 'fontstring' && f.text && /AltOne|AltTwo|TestChar/.test(String(f.text)))
    .map((f) => String(f.text));
  ok(labels.some((t) => /TestChar/.test(t) && /始终显示|always shown/.test(t)),
     '10) 全新存档：自身仍列出并标注"始终显示"');
  ok(!labels.some((t) => /AltOne|AltTwo/.test(t)), '10) 全新存档：不出现其他角色行');
}

/* ── 11. 内存瘦身：缓存上限 / 空结果不缓存 / 弃用角色清理 ──────── */
{
  // 11a 悬停缓存有上限（FIFO 128）：悬停 140 个不同物品后缓存 ≤ 128
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  const size = () => mock.evalLua('return StockTake.Tooltip:CacheSize()').value;
  for (let id = 1; id <= 140; id++) {
    mock.setItemCount(id, 2);
    mock.invokeItemTooltipFlow(mock.gameTooltip, { id }, [{ type: 'ItemName', text: 'I' + id }]);
  }
  ok(size() <= 128, `11) 缓存上限：悬停 140 个物品后缓存 ${size()} ≤ 128`);
  ok(size() > 100, `11) 缓存仍然有效（${size()} 条，不是被误清空）`);
}
{
  // 11b 谁都没有的物品不缓存
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  mock.setItemCount(999, 0);
  mock.invokeItemTooltipFlow(mock.gameTooltip, { id: 999 }, [{ type: 'ItemName', text: 'X' }]);
  eq(mock.evalLua('return StockTake.Tooltip:CacheSize()').value, 0, '11) 空结果不缓存');
}
{
  // 11c lastSeen 在扫描时记录
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  const key = mock.evalLua('return StockTake.player.key').value;
  ok(mock.getGlobal('SL2_DB').chars[key].lastSeen !== undefined, '11) 扫描记录 lastSeen');
}
{
  // 11d /sl clean：清掉超期未登录的角色，活跃与自身保留
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  seedAlts(mock);
  // AltOne 100 天前；AltTwo 刚刚；一条无 lastSeen 的旧记录（应保留，保守策略）
  mock.runLuaCode(
    'SL2_DB.chars["TestRealm-AltOne"].lastSeen = time() - 100 * 86400\n' +
    'SL2_DB.chars["TestRealm-Legacy"] = { name = "Legacy", class = "ROGUE", bags = {}, bank = {} }'
  );
  mock.invokeSlash('STOCKTAKE', 'clean');
  const chars = mock.evalLua('local t={} for k in pairs(SL2_DB.chars) do t[#t+1]=k end table.sort(t) return table.concat(t,",")').value;
  ok(!/AltOne/.test(chars), '11) clean 移除超期角色（AltOne）');
  ok(/AltTwo/.test(chars) && /TestChar/.test(chars), '11) 活跃角色与自身保留');
  ok(/Legacy/.test(chars), '11) 无 lastSeen 的旧记录保留（保守：下次登录补时间戳后再可清）');
  // 提示框同步不再显示被清角色
  mock.setItemCount(100, 2);
  mock.invokeItemTooltipFlow(mock.gameTooltip, { id: 100 }, [{ type: 'ItemName', text: 'I' }]);
  const text = readLines(mock, 'GameTooltip').map((l) => l.text).join(' ');
  ok(!/AltOne/.test(text), '11) 清理后提示框不再显示被移除的角色');
  // 自定义天数：clean 200 → AltOne（100 天前）不再命中 cutoff
  const m2 = load(SCENARIO);
  lifecycle(m2.mock);
  seedAlts(m2.mock);
  m2.mock.runLuaCode('SL2_DB.chars["TestRealm-AltOne"].lastSeen = time() - 100 * 86400');
  m2.mock.invokeSlash('STOCKTAKE', 'clean 200');
  const chars2 = m2.mock.evalLua('local t={} for k in pairs(SL2_DB.chars) do t[#t+1]=k end table.sort(t) return table.concat(t,",")').value;
  ok(/AltOne/.test(chars2), '11) /sl clean 200（阈值放宽）不误删 100 天前的角色');
}

/* ── 6. 设置面板注册 ───────────────────────────────────────────── */
{
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  const calls = (mock.calls || []).map((c) => c.name);
  ok(calls.indexOf('Settings.RegisterCanvasLayoutCategory') !== -1, '6) 使用 Blizzard Settings API 注册分类');
  ok(calls.indexOf('Settings.RegisterAddOnCategory') !== -1, '6) 分类已加入选项面板');
  ok(mock.evalLua('return SLASH_STOCKTAKE1').value === '/st'
     && mock.evalLua('return SLASH_STOCKTAKE2').value === '/stocktake',
     '6) 斜杠命令已注册：短 /st、长 /stocktake（0.9.4 起）');

  // 回归：勾选框模板（SettingsCheckboxTemplate）**本身没有文本元素**，
  // 且对它调 Button:SetText 会造出无锚点、看不见的 FontString。
  // 因此断言：标签必须真的作为 FontString（带锚点）被创建，且控件必须有全局名。
  const frames = Object.values(mock.frames);
  const fontTexts = frames.filter((f) => f.kind === 'fontstring' && f.text).map((f) => f.text);
  for (const expected of ['显示合计行', '提示框字体大小', '显示哪些角色']) {
    ok(fontTexts.indexOf(expected) !== -1, `6) 标签「${expected}」已作为 FontString 创建（模板无文本元素）`);
  }
  // 0.9.4：与「显示哪些角色」重复的「显示其他角色」复选框已移除，不得再出现
  ok(fontTexts.indexOf('显示其他角色') === -1, '6) 「显示其他角色」复选框已移除（与角色勾选列表重复）');
  // 控件名由共享计数器生成（Check1 / Label2 / Check3 …），因此按模式统计而不是写死编号
  const controls = frames.filter((f) => f.name && /^StockTakeOpt(Check|Slider)\d+$/.test(f.name));
  const nCheck = controls.filter((f) => /Check/.test(f.name)).length;
  const nSlider = controls.filter((f) => /Slider/.test(f.name)).length;
  // v0.9.2 起登录（PLAYER_READY）即构建角色区：本场景无其他角色 → 1 基础 + 1 自身（disabled）
  ok(nCheck === 2, `6) 勾选框都有全局名（1 基础 + 1 自身，实际 ${nCheck}）`);
  ok(nSlider === 1, `6) 字号滑条有全局名（实际 ${nSlider}）`);
  const checkWithText = frames.filter((f) => f.name && /^StockTakeOptCheck\d+$/.test(f.name) && f.text);
  ok(checkWithText.length === 0, '6) 勾选框自身不被 SetText（避免无锚点不可见文本）');
  // 悬停：必须由本插件接管 OnEnter/OnLeave（否则模板会 Show 出反白的 HoverBackground）。
  // 角色区的 disabled 自身项无提示文本，刻意不接管（真实客户端禁用控件不响应鼠标）——
  // 只检查可交互控件（enabled !== false）。
  const interactive = controls.filter((f) => f.enabled !== false);
  const missingHover = interactive.filter((f) => !f.scripts || !f.scripts.OnEnter || !f.scripts.OnLeave);
  ok(missingHover.length === 0, `6) 可交互控件已接管 OnEnter/OnLeave（抑制悬停反白背景，缺失 ${missingHover.length} 个）`);
}

/* ── 12. 0.9.4 回归：银行开着时刷新 / 字号还原 / 滑条吸附 / GetRegions ── */
{
  // 12a 银行开着时存取：BAG_UPDATE_DELAYED 必须一并重扫银行（此前只扫背包）
  // 注意：装置里"清空容器"默认等于"容量 0 = 未加载"；要模拟"取空了但页还在"，
  // 必须用 containerSlots 声明银行页容量（与真实客户端一致：空页也有槽）。
  const sc12 = Object.assign({}, SCENARIO, { containerSlots: { '-4': 7, 6: 98, 7: 98 } });
  const { mock } = load(sc12);
  lifecycle(mock);
  const key = mock.evalLua('return StockTake.player.key').value;
  const bankOf = () => mock.getGlobal('SL2_DB').chars[key].bank;
  mock.fireEvent('BANKFRAME_OPENED');
  mock.advanceTime(0.6);
  eq(bankOf()['500'], 5, '12) 开行即记录银行（item500 = 2+3）');

  // 模拟银行开着时把银行页 6 的 item500 全部取走 → 只有 BAG_UPDATE_DELAYED 会来
  mock.setContainer(6, []);
  mock.fireEvent('BAG_UPDATE_DELAYED');
  mock.advanceTime(0.4);
  eq(bankOf()['500'], 3, '12) 银行开着时变动 → 银行快照随 BAG_UPDATE_DELAYED 刷新（0+3）');

  // 关行后的背包变化不再动银行快照（银行容器此时不可读，重扫反而危险）
  mock.fireEvent('BANKFRAME_CLOSED');
  mock.setContainer(7, []);
  mock.fireEvent('BAG_UPDATE_DELAYED');
  mock.advanceTime(0.4);
  eq(bankOf()['500'], 3, '12) 关行后 BAG_UPDATE_DELAYED 不再改银行快照');
  // 背包侧照常工作
  const bagsOf = () => mock.getGlobal('SL2_DB').chars[key].bags;
  mock.setContainer(0, [it(500, 4)]);
  mock.fireEvent('BAG_UPDATE_DELAYED');
  mock.advanceTime(0.3);
  eq(bagsOf()['500'], 4, '12) 关行后背包快照仍随事件刷新');
}
{
  // 12b 字号改回"跟随游戏"：被改过字号的行必须还原（此前只停止新的改写）
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  mock.setItemCount(100, 2);
  mock.runLuaCode('GameTooltip:AddLine("原生行")');
  const fs1 = () => Object.values(mock.frames).find((x) => x.name === 'GameTooltipTextLeft1');
  // 真实客户端里每行总有自己的字体；装置默认无字体，这里补一个"游戏默认"再测
  fs1().font = { path: 'Fonts\\FRIZQT__.TTF', height: 12, flags: '' };
  mock.evalLua('StockTake:Set("fontSize", 20)');
  mock.invokeTooltipPostCall(1, mock.gameTooltip, { id: 100 });
  ok(fs1() && fs1().font.height === 20, '12) 自定义字号已应用到带原始字体的行（20）');
  mock.evalLua('StockTake:Set("fontSize", 0)');
  eq(fs1() && fs1().font.height, 12, '12) 改回「跟随游戏」后还原为原始字号 12');
}
{
  // 12c 滑条 1–5 吸附为 6（渲染端 FONT_MIN=6，此前显示与实际不符）；0 与 ≥6 不受影响
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  const slider = Object.values(mock.frames).find(
    (f) => f.name && /^StockTakeOptSlider\d+$/.test(f.name)
  );
  ok(!!slider, '12) 找到字号滑条');
  const get = () => mock.evalLua('return StockTake:Get("fontSize")').value;
  mock.evalLua(slider.name + ':SetValue(3)');
  eq(get(), 6, '12) 滑条 3 吸附为 6');
  eq(mock.evalLua('return ' + slider.name + ':GetValue()').value, 6, '12) 滑块位置同步吸附到 6');
  mock.evalLua(slider.name + ':SetValue(0)');
  eq(get(), 0, '12) 0 仍为「跟随游戏」，不被吸附');
  mock.evalLua(slider.name + ':SetValue(9)');
  eq(get(), 9, '12) ≥6 的值原样保存');
}
{
  // 12d 未编号 FontString 的兜底字号：GetRegions 返回 varargs（此前兜底永远不执行）
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  mock.evalLua('StockTake:Set("fontSize", 18)');
  mock.runLuaCode(
    'local fs = GameTooltip:CreateFontString(nil, "ARTWORK")\n' +
    'fs:SetText("plain")\n' +
    '_G.__plainFS = fs'
  );
  mock.setItemCount(100, 2);
  mock.invokeItemTooltipFlow(mock.gameTooltip, { id: 100 }, [{ type: 'ItemName', text: 'I' }]);
  eq(
    mock.evalLua('return select(2, _G.__plainFS:GetFont())').value, 18,
    '12) GetRegions 兜底：未编号 FontString 也拿到字号 18'
  );
}

{
  // 12e 已装备件数不计入「背」
  //（0.9.4 曾"修"过一次，但用的是真机不存在的 C_Item.GetEquippedCount，从未生效；
  //  0.9.7 改为遍历装备槽自数。已装备态的权威来源 = 装备槽，装置用 GetInventoryItemID 暴露。）
  // 装备在**登录前**就位：检验 PLAYER_ENTERING_WORLD 那一刻构建的装备表（真机时序即如此）。
  const sc = Object.assign({}, SCENARIO, { equip: { 11: { itemID: 700 }, 12: { itemID: 700 } } });
  const { mock } = load(sc);
  lifecycle(mock);
  mock.setItemCount(700, 5);          // 基准计数 5（含已装备 2，与客户端口径一致）
  mock.setItemCountBank(700, 3);
  mock.invokeItemTooltipFlow(mock.gameTooltip, { id: 700 }, [{ type: 'ItemName', text: 'I700' }]);
  const lines = readLines(mock, 'GameTooltip').map((l) => l.text);
  const self = lines.find((t) => /TestChar/.test(t));
  ok(self != null, '12) 当前角色行存在（已装备场景）');
  ok(self && self.indexOf('背 3') !== -1, `12) 「背」= 5−2（装备）= 3（实际：${self}）`);
  ok(self && self.indexOf('银 3') !== -1, `12) 「银」不受装备数影响 = 3（实际：${self}）`);
  ok(self && self.indexOf('装备 2') !== -1, `12) 装备单独成列显示 2（实际：${self}）`);
  ok(self && self.indexOf(': 8') !== -1, `12) 总数 = 背3+银3+装备2 = 8（实际：${self}）`);

  // 12f 换装后已显示的提示框立即更新（PLAYER_EQUIPMENT_CHANGED → 重建装备表 → 缓存失效 → 重放）
  // 先记下换装前的显示值——必须断言这个"变化"本身，否则在装备数恒为 0 的坏状态下本用例会假通过。
  const shownBefore = readLines(mock, 'GameTooltip').map((l) => l.text).join(' ');
  ok(/背 3/.test(shownBefore), `12) 换装前已显示「背 3」（实际：${shownBefore}）`);
  // 卸下两件：物品仍在身上（基准计数不变），但不再计入装备数 → 「背」应升到 5。
  mock.setEquipped(700, 0);
  mock.fireEvent('PLAYER_EQUIPMENT_CHANGED', 11, false);
  mock.advanceTime(0.1);              // 刷新去抖（0.05）
  mock.advanceTime(0.1);              // 同轮新建的定时器要下一轮才触发
  const after = readLines(mock, 'GameTooltip').map((l) => l.text).join(' ');
  ok(/背 5/.test(after), `12) 卸下装备后「背」变为 5（实际：${after}）`);
  ok(!/背 3/.test(after), '12) 卸装前的旧数字不再残留');
  ok(!/装备/.test(after), `12) 卸光后「装备」列消失（实际：${after}）`);
}

{
  // 12h 只戴着、没有备件：这一行仍须出现。
  // 这是 0.9.7 修好"减装备数"之后冒出来的回归——装备被减光后 bags+bank=0，
  // 被"一件都没有就不占位"挡掉，于是悬停自己身上的装备什么都看不到。
  const sc = Object.assign({}, SCENARIO, { equip: { 11: { itemID: 800 } } });
  const { mock } = load(sc);
  lifecycle(mock);
  mock.setItemCount(800, 1);          // 基准计数 1，就是身上那一件
  mock.invokeItemTooltipFlow(mock.gameTooltip, { id: 800 }, [{ type: 'ItemName', text: 'I800' }]);
  const lines = readLines(mock, 'GameTooltip').map((l) => l.text);
  const self = lines.find((t) => /TestChar/.test(t));
  ok(self != null, `12) 装备-only 物品仍显示当前角色行（实际：${lines.join(' | ')}）`);
  ok(self && self.indexOf('背 0') !== -1, `12) 明示「背 0」（实际：${self}）`);
  ok(self && self.indexOf('装备 1') !== -1, `12) 明示「装备 1」（实际：${self}）`);
  ok(self && self.indexOf(': 1') !== -1, `12) 总数 1（实际：${self}）`);
}

{
  // 12g 装置保真度门禁：模拟环境**不得**提供真机不存在的 API 与枚举成员。
  // 这两样都曾真实存在过，并分别掩盖了一个缺陷：
  //   · C_Item.GetEquippedCount 桩 → 让"减装备数"的失效修复在 202/202 全绿下藏了三个版本
  //   · Enum.BagIndex.BankBag 假成员 → 让 Scan.lua 里引用它的死代码"看起来能跑"
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  ok(mock.evalLua('return C_Item.GetEquippedCount').value == null,
     '12) 装置不提供 C_Item.GetEquippedCount（12.1.0 真机没有）');
  ok(mock.evalLua('return GetEquippedCount').value == null,
     '12) 装置不提供全局 GetEquippedCount（12.1.0 真机没有）');
  ok(mock.evalLua('return Enum.BagIndex.BankBag').value == null,
     '12) 装置不提供 Enum.BagIndex.BankBag（11.2.7 起已无此成员）');
}

/* ── 13. 0.9.4 追加：实时刷新 / 银行疑似空复核 / 斜杠端到端分发 ────── */
{
  // 13a 已显示的提示框必须随数据变化实时刷新（审计确认的显示滞后）
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  mock.setItemCount(100, 2);
  mock.invokeItemTooltipFlow(mock.gameTooltip, { id: 100 }, [{ type: 'ItemName', text: 'I' }]);
  let text = readLines(mock, 'GameTooltip').map((l) => l.text).join(' ');
  ok(text.indexOf('TestChar') !== -1 && /: 2/.test(text), '13) 首帧显示数量 2');

  // 悬停中数量变化（模拟消耗/存入）→ BAG_UPDATE_DELAYED → 扫描 → DATA_CHANGED
  mock.setItemCount(100, 9);
  mock.fireEvent('BAG_UPDATE_DELAYED');
  mock.advanceTime(0.3);                    // 先跑 bags 扫描（0.2 去抖）→ DATA_CHANGED
  mock.advanceTime(0.1);                    // 再跑刷新去抖（0.05）：同轮新建的定时器要下一轮才触发
  text = readLines(mock, 'GameTooltip').map((l) => l.text).join(' ');
  ok(/: 9/.test(text), `13) 已显示的提示框立即刷新为 9（实际：${text}）`);
  ok(!/: 2/.test(text), '13) 旧数字不再残留');

  // 13b 字号变化同样刷新已显示的提示框
  mock.evalLua('StockTake:Set("fontSize", 20)');
  mock.advanceTime(0.1);
  const lines = readLines(mock, 'GameTooltip');
  const sized = lines.filter((l) => l.font && l.font.height === 20);
  ok(sized.length > 0, '13) 改字号后已显示的提示框即时套用新字号');
}
{
  // 13c 银行"疑似空"：不当场覆盖非空快照，复核后仍为空才落地
  const sc = Object.assign({}, SCENARIO, { containerSlots: { '-4': 7, 6: 98, 7: 98 } });
  const { mock } = load(sc);
  lifecycle(mock);
  const key = mock.evalLua('return StockTake.player.key').value;
  const bankOf = () => mock.getGlobal('SL2_DB').chars[key].bank;
  mock.fireEvent('BANKFRAME_OPENED');
  mock.advanceTime(0.6);
  eq(bankOf()['500'], 5, '13) 银行初扫 = 5');

  // 两页同时"变空"（容量仍在）→ 属于可疑空：先保留旧快照
  mock.setContainer(6, []);
  mock.setContainer(7, []);
  mock.fireEvent('BAG_UPDATE_DELAYED');
  mock.advanceTime(0.4);                    // 0.2 bags + 0.3 bank 去抖已到；复核(0.5)未到
  eq(bankOf()['500'], 5, '13) 疑似空不当场覆盖（保留旧快照）');
  mock.advanceTime(0.6);                    // 越过 0.5s 复核
  eq(bankOf()['500'], undefined, '13) 复核仍为空 → 正常落地为空');
}
{
  // 13d 斜杠命令端到端：只认插件自己注册的 SLASH_* → SlashCmdList 链路
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  ok(mock.invokeSlashCommand('st', '').ok, '13) /st 可分发到处理器（SLASH_STOCKTAKE1 反查）');
  ok(mock.invokeSlashCommand('stocktake', 'zh').ok, '13) /stocktake 可分发');
  eq(mock.evalLua('return StockTake:CurrentLocale()').value, 'zhCN', '13) /stocktake zh 切到中文');
  const old = mock.invokeSlashCommand('sl', '');
  ok(!old.ok, '13) 已释放的 /sl 不再被本插件接管（别名只剩 /st、/stocktake）');
}

/* ── 14. 0.9.5：面板在存档就绪后构建 + 语言即时重贴 ────────────────── */
{
  // 14a 存档里的语言覆盖与实际字号必须作用到面板上
  //（旧实现把面板文字绑在文件加载期：那时 SL2_DB 还没到 → 永远是客户端语言 + 默认字号）
  const { mock } = load(SCENARIO);
  mock.runLuaCode('SL2_DB.options = { locale = "enUS", fontSize = 20, showTotal = true }');
  mock.fireEvent('ADDON_LOADED', ADDON_NAME);
  const texts = Object.values(mock.frames).filter((f) => f.kind === 'fontstring' && f.text).map((f) => String(f.text));
  ok(texts.indexOf('Show total line') !== -1, '14) 存档 locale=enUS：复选框标签为英文');
  ok(texts.indexOf('Tooltip font size') !== -1, '14) 滑条标签为英文');
  ok(texts.some((t) => typeof t === 'string' && t.indexOf('Command: /st') === 0), '14) 提示行为英文');
  ok(texts.indexOf('显示合计行') === -1, '14) 面板里不再残留中文标签');

  const slider = Object.values(mock.frames).find((f) => f.name && /^StockTakeOptSlider\d+$/.test(f.name));
  ok(!!slider, '14) 字号滑条已创建');
  eq(mock.evalLua('return ' + slider.name + ':GetValue()').value, 20, '14) 滑条初值 = 存档字号 20（而非默认 0）');
  eq(mock.evalLua('return StockTake:Get("fontSize")').value, 20, '14) 配置值保持 20');
}
{
  // 14b 运行中切换语言：必须走**真实命令路径**（/st en、/st zh），面板标签即时重贴。
  // 之前这里直接调 StockTake:Set()，掩盖了"命令直写存档、不派发 CONFIG_CHANGED"的缺陷。
  const { mock } = load(SCENARIO);
  lifecycle(mock);
  const has = (s) => Object.values(mock.frames).some((f) => f.kind === 'fontstring' && String(f.text) === s);
  ok(has('显示合计行'), '14) 中文客户端：面板为中文');
  const hasSub = (s) => Object.values(mock.frames).some((f) => f.kind === 'fontstring' && typeof f.text === 'string' && f.text.indexOf(s) !== -1);
  ok(mock.invokeSlashCommand('st', 'en').ok, '14) /st en 命令可分发');
  ok(has('Show total line'), '14) /st en 后面板标签即时变英文');
  ok(has('Which characters to show'), '14) /st en 后角色区标题也变英文（角色区同样登记了重贴）');
  ok(hasSub('(current character, always shown)'), '14) /st en 后当前角色行的后缀也变英文');
  ok(!has('显示哪些角色'), '14) 中文角色区标题已被替换');
  ok(!has('显示合计行'), '14) 中文标签已被替换（无残留）');
  eq(mock.evalLua('return StockTake:Get("locale")').value, 'enUS', '14) 存档语言值已写入 enUS');
  ok(mock.invokeSlashCommand('st', 'zh').ok, '14) /st zh 命令可分发');
  ok(has('显示合计行'), '14) /st zh 后即时切回中文');
  ok(hasSub('（当前角色，始终显示）'), '14) /st zh 后当前角色行的后缀也回到中文');
  ok(!hasSub('(current character, always shown)'), '14) 英文后缀未残留');
  eq(mock.evalLua('return StockTake:Get("locale")').value, 'zhCN', '14) 存档语言值已写回 zhCN');
  mock.invokeSlashCommand('st', 'auto');
  ok(mock.evalLua('return tostring(StockTake:Get("locale"))').value === 'nil', '14) /st auto 清掉覆盖，回到跟随客户端');
}

/* ── 汇总 ───────────────────────────────────────────────────────── */
console.log(`汇总：${total} 用例，${passed} 通过，${total - passed} 失败`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
}
process.exit(total - passed === 0 ? 0 : 1);
