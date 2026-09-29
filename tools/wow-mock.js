#!/usr/bin/env node
/**
 * wow-mock.js — WoW 12.x API 无头模拟层（基于 fengari 纯 JS Lua 5.3 VM）
 *
 * 职责：
 *  1. 建一个 fengari Lua 状态机，注入与规划第三章"已冻结 API 事实"一致的 WoW 全局环境；
 *  2. 让插件源码（`local ADDON_NAME, SL = ...` 约定）能被逐文件加载执行；
 *  3. 所有 mock 方法都"可编程场景"：测试可塞入假背包/银行/战团/装备数据并触发事件；
 *  4. 记录所有 mock 调用（供断言与审计）。
 *
 * 用法（被 smoke-test.js 引用）：
 *   const { createWowMock } = require('./wow-mock');
 *   const m = createWowMock();
 *   m.setGlobal('SL_DB', {});            // 注入 SavedVariables
 *   m.loadFile('.../Core.lua', 'StockTake', m.getAddonTable());
 *   m.fireEvent('ADDON_LOADED', 'StockTake');
 *   m.fireEvent('PLAYER_ENTERING_WORLD', true, false);
 *   const db = m.getGlobal('SL_DB');
 */
'use strict';

const { lua, lauxlib, lualib, to_luastring } = require('fengari');

/* ------------------------------------------------------------------ *
 * UTF-8 安全字符串桥接（fengari 内建 to_luastring/to_jsstring 对非 ASCII
 * 仅按 Latin-1 处理，这里用 Buffer 做真正的 UTF-8 编解码）
 * ------------------------------------------------------------------ */
const utf8ls = (s) => new Uint8Array(Buffer.from(String(s), 'utf8'));
const jsstr = (ls) => {
  if (ls == null) return null;
  return Buffer.from(ls.buffer, ls.byteOffset, ls.byteLength).toString('utf8');
};

/* ------------------------------------------------------------------ *
 * 场景默认值（测试可整体替换或逐字段修改）
 * ------------------------------------------------------------------ */
/**
 * 与装置内 FontString:GetStringWidth 一致的文本度量（分字符类别，比均匀模型更接近比例字体）：
 * 空格 = 0.25 em，CJK（含全角标点）= 1.0 em，其它字符 = 0.5 em；忽略颜色转义。
 * 注意：仍是合成模型 —— 对齐断言验证的是**补白算法**，真实字体的像素对齐需游戏内目检。
 */
function measureText(text, size) {
  const plain = String(text == null ? '' : text)
    .replace(/\|[cC][0-9a-fA-F]{8}/g, '')
    .replace(/\|r/g, '');
  let units = 0;
  for (const ch of plain) {
    if (ch === ' ') units += 0.25;
    else if (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)) units += 1.0;
    else units += 0.5;
  }
  return units * (size || 12);
}

function defaultScenario() {
  return {
    locale: 'zhCN',                          // GetLocale() 返回
    clock: 1700000000,                       // time() 返回的可控时钟
    player: {
      name: 'TestChar', realm: 'TestRealm',
      charKey: 'TestRealm-TestChar',
      class: 'WARRIOR', classID: 1, localizedClass: '\u6218\u58eb', // 战士
      faction: 'Alliance',
    },
    containers: {},                          // bagID -> [{itemID,stackCount,itemName,iconFileID,quality}]
    equip: {},                               // slot -> {itemID,link,texture,quality}；已装备态的**唯一事实源**
    bankTabIDs: { 0: [6, 7, 9], 1: [], 2: [12, 14] },  // BankType: Character/Guild/Account
    itemMeta: {},                            // itemID -> {name,icon,quality}
    itemCount: {},                           // itemID -> C_Item.GetItemCount 基准计数（**含已装备**，与客户端口径一致）
    itemCountBank: {},                       // itemID -> 角色银行（includeBank=true 时相加）
    itemCountReagent: {},                    // itemID -> 材料银行（includeReagentBank=true 时相加）
    itemCountAccount: {},                    // itemID -> 战团银行（includeAccountBank=true 时相加）
    money: 0,
    savedVars: null,                         // 若提供，作为 _G.SL_DB 种子（JS 对象）
    features: { accountBank: true },         // 战团特性探测开关
  };
}

function createWowMock(opts) {
  const scenario = Object.assign(defaultScenario(), opts && opts.scenario);

  /* ------------------------- 状态容器 ------------------------- */
  const calls = [];        // mock 调用日志
  const errors = [];       // 事件分发 / timer / pcall 中捕获的 Lua 错误
  const printLog = [];     // print() 捕获
  const frames = {};       // id -> frame meta
  const eventRegistry = {};// event -> Set<frameId>
  const timers = {};       // timerId -> {delay,fnRef,remaining,scheduledFor}
  const tooltipPostCall = {}; // type -> [fnRef]
  const tooltipPreCall = {};  // type -> [fnRef]
  const linePreCall = {};     // lineType -> [fnRef]
  const linePostCall = {};    // lineType -> [fnRef]
  // 逐行回调用的行类型（取值只需互不相同；ItemName 是 Blizzard 自己在用的插入点）
  const LINE_TYPES = { ItemName: 101, ItemLevel: 102, ItemBinding: 103, Separator: 104 };
  const slashHandlers = {};   // name -> fnRef
  const secureHooks = [];     // {table, method, hookRef}

  let nextId = 1;
  let nextTimerId = 1;
  let childCounter = 0;

  /* ------------------------- Lua 状态 ------------------------- */
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  /* ------------------------- 基础辅助 ------------------------- */
  function jsArg(Ls, i) {
    const t = lua.lua_type(Ls, i);
    if (t === lua.LUA_TNIL) return null;
    if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(Ls, i);
    if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(Ls, i);
    if (t === lua.LUA_TSTRING) return jsstr(lua.lua_tolstring(Ls, i));
    if (t === lua.LUA_TTABLE) return '[table]';
    if (t === lua.LUA_TFUNCTION) return '[function]';
    return '[type:' + t + ']';
  }

  // 把 JS 值压栈（含函数 → JS closure）。
  // 同一性保持：普通对象带 WeakMap 缓存（同一 JS 对象 → 同一张 Lua 表），
  // 否则每次转换都生成新表，被测代码里 "lineData == p.lastLine" 这类引用判据永远为假（审计 C-3）。
  const jsObjectRefs = new WeakMap();

  function pushJsValue(Ls, v) {
    if (v === null || v === undefined) { lua.lua_pushnil(Ls); return; }
    const ty = typeof v;
    if (ty === 'number') { lua.lua_pushnumber(Ls, v); return; }
    if (ty === 'boolean') { lua.lua_pushboolean(Ls, v); return; }
    if (ty === 'string') { lua.lua_pushstring(Ls, utf8ls(v)); return; }
    if (ty === 'function') { lua.lua_pushjsfunction(Ls, v); return; }
    if (Array.isArray(v)) {
      lua.lua_createtable(Ls, v.length, 0);
      for (let i = 0; i < v.length; i++) { pushJsValue(Ls, v[i]); lua.lua_seti(Ls, -2, i + 1); }
      return;
    }
    if (ty === 'object') {
      const cached = jsObjectRefs.get(v);
      if (cached != null) { lua.lua_rawgeti(Ls, lua.LUA_REGISTRYINDEX, cached); return; }
      lua.lua_createtable(Ls, 0, Object.keys(v).length);
      for (const k of Object.keys(v)) { pushJsValue(Ls, v[k]); lua.lua_setfield(Ls, -2, to_luastring(k)); }
      lua.lua_pushvalue(Ls, -1);                                              // 复制一份用于登记
      const ref = lauxlib.luaL_ref(Ls, lua.LUA_REGISTRYINDEX);                // 弹出复制，原表留在栈顶
      jsObjectRefs.set(v, ref);
      return;
    }
    lua.lua_pushnil(Ls);
  }

  // 把 Lua 值（在 idx）转成 JS；table → 数组或对象，function → "[function]"
  function luaToJs(Ls, idx, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 24) return '[deep]';
    const t = lua.lua_type(Ls, idx);
    if (t === lua.LUA_TNIL) return null;
    if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(Ls, idx);
    if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(Ls, idx);
    if (t === lua.LUA_TSTRING) return jsstr(lua.lua_tolstring(Ls, idx));
    if (t === lua.LUA_TFUNCTION) return '[function]';
    if (t === lua.LUA_TTABLE) {
      const abs = lua.lua_absindex(Ls, idx);
      const numEntries = [];
      const strEntries = [];
      lua.lua_pushnil(Ls);
      while (lua.lua_next(Ls, abs) !== 0) {
        // key 在 -2，value 在 -1
        const kt = lua.lua_type(Ls, -2);
        let key = null;
        if (kt === lua.LUA_TNUMBER) key = lua.lua_tonumber(Ls, -2);
        else if (kt === lua.LUA_TSTRING) key = 's:' + jsstr(lua.lua_tolstring(Ls, -2));
        if (key !== null) {
          const val = luaToJs(Ls, -1, depth + 1);
          if (typeof key === 'number') numEntries.push({ k: key, v: val });
          else strEntries.push({ k: key.slice(2), v: val });
        }
        lua.lua_pop(Ls, 1); // 弹出 value，保留 key 供下一轮
      }
      if (strEntries.length === 0) {
        // 仅当数值键是稠密的 1..n 时视为数组（如 rows 列表）；稀疏大键（itemID 计数表）转对象
        let max = 0;
        for (const e of numEntries) if (e.k > max) max = e.k;
        const intKeys = numEntries.filter((e) => Number.isInteger(e.k) && e.k >= 1);
        const dense = intKeys.length === max && max > 0 && intKeys.length === numEntries.length;
        if (dense) {
          const arr = new Array(max);
          for (const e of numEntries) arr[e.k - 1] = e.v;
          return arr;
        }
      }
      const obj = {};
      for (const e of numEntries) obj[String(e.k)] = e.v;
      for (const e of strEntries) obj[e.k] = e.v;
      return obj;
    }
    return '[v:' + t + ']';
  }

  function setGlobal(name, value) {
    pushJsValue(L, value);
    lua.lua_setglobal(L, to_luastring(name));
  }

  function getGlobal(name) {
    lua.lua_getglobal(L, to_luastring(name));
    const v = luaToJs(L, -1);
    lua.lua_pop(L, 1);
    return v;
  }

  function refArg(Ls, i) {
    lua.lua_pushvalue(Ls, i);
    return lauxlib.luaL_ref(Ls, lua.LUA_REGISTRYINDEX);
  }

  function pushRef(ref) { lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref); }

  /* ------------------------- 帧 / 区域 ------------------------- */
  function selfId(Ls) {
    lua.lua_getfield(Ls, 1, to_luastring('__id'));
    const id = lua.lua_tonumber(Ls, -1);
    lua.lua_pop(Ls, 1);
    return id;
  }
  function selfMeta(Ls) { return frames[selfId(Ls)]; }

  // 共享方法表（所有区域共用，按 kind/meta 字段区分行为）
  let regionMethodsRef = null;

  // 参数转换必须容错：frame 表带元表（含函数），递归转换会抛错，
  // 而 logApi 若因此抛错会把整次 API 调用变成失败（pcall 会捕获到）。
  function safeArg(Ls, i) {
    try { return jsArg(Ls, i); } catch (e) { return '<unconvertible>'; }
  }

  function logRegion(method, meta, Ls, fromIdx) {
    const args = [];
    const n = lua.lua_gettop(Ls);
    for (let i = fromIdx || 2; i <= n; i++) args.push(safeArg(Ls, i));
    calls.push({ scope: 'region', method, frame: meta.name, args });
  }

  function logApi(name, Ls, fromIdx) {
    const args = [];
    const n = lua.lua_gettop(Ls);
    for (let i = fromIdx || 1; i <= n; i++) args.push(safeArg(Ls, i));
    calls.push({ scope: 'api', name, args });
  }

  // 建一个区域并返回 id（同时把区域表留在栈顶，便于方法 `return 1`）
  function newRegion(kind, name, parentId) {
    const id = nextId++;
    lua.lua_createtable(L, 0, 0);
    lua.lua_pushnumber(L, id); lua.lua_setfield(L, -2, to_luastring('__id'));
    lua.lua_pushstring(L, utf8ls(kind)); lua.lua_setfield(L, -2, to_luastring('__kind'));
    if (name != null) { lua.lua_pushstring(L, utf8ls(name)); lua.lua_setfield(L, -2, to_luastring('name')); }
    lua.lua_createtable(L, 0, 1);
    pushRef(regionMethodsRef);
    lua.lua_setfield(L, -2, to_luastring('__index'));
    lua.lua_setmetatable(L, -2);
    const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX); // 弹出区域表
    frames[id] = {
      id, kind, name: name || null, ref, parent: parentId || null,
      scripts: {}, hooks: {}, events: {},
      shown: true, w: 0, h: 0, numLines: 0, text: null, scale: 1, alpha: 1,
      font: { path: null, height: 12, flags: '' },
    };
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref); // 重新压栈供返回
    return id;
  }

  function pushFrame(id) { lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, frames[id].ref); }

  function setRegionText(id, text) {
    const meta = frames[id];
    if (meta) meta.text = text;
  }

  // 往某个 frame 追加一行文本；AddLine 方法与"提示框流程驱动"共用
  function appendLine(meta, text) {
    const N = (meta.numLines || 0) + 1;
    meta.numLines = N;
    const base = meta.name || 'Tooltip';
    const name = base + 'TextLeft' + N;
    const id = newRegion('fontstring', name, meta.id);   // 区域留在栈顶
    setRegionText(id, text);
    lua.lua_pushvalue(L, -1);
    lua.lua_setglobal(L, to_luastring(name));
    lua.lua_pop(L, 1);                                   // 弹回，保持栈平衡
    return id;
  }

  function buildRegionMethods() {
    return {
      SetScript: function (Ls) {
        const meta = selfMeta(Ls);
        const type = jsArg(Ls, 2);
        const ref = refArg(Ls, 3);
        meta.scripts[type] = ref;
        logRegion('SetScript', meta, Ls);
        return 0;
      },
      GetScript: function (Ls) {
        const meta = selfMeta(Ls);
        const type = jsArg(Ls, 2);
        const ref = meta.scripts[type];
        if (ref == null) { lua.lua_pushnil(Ls); } else { pushRef(ref); }
        return 1;
      },
      HookScript: function (Ls) {
        const meta = selfMeta(Ls);
        const type = jsArg(Ls, 2);
        const ref = refArg(Ls, 3);
        (meta.hooks[type] = meta.hooks[type] || []).push(ref);
        logRegion('HookScript', meta, Ls);
        return 0;
      },
      RegisterEvent: function (Ls) {
        const meta = selfMeta(Ls);
        const ev = jsArg(Ls, 2);
        meta.events[ev] = true;
        (eventRegistry[ev] = eventRegistry[ev] || new Set()).add(meta.id);
        logRegion('RegisterEvent', meta, Ls);
        return 0;
      },
      RegisterUnitEvent: function (Ls) {
        const meta = selfMeta(Ls);
        const ev = jsArg(Ls, 2);
        meta.events[ev] = true;
        (eventRegistry[ev] = eventRegistry[ev] || new Set()).add(meta.id);
        logRegion('RegisterUnitEvent', meta, Ls);
        return 0;
      },
      UnregisterEvent: function (Ls) {
        const meta = selfMeta(Ls);
        const ev = jsArg(Ls, 2);
        delete meta.events[ev];
        if (eventRegistry[ev]) eventRegistry[ev].delete(meta.id);
        return 0;
      },
      UnregisterAllEvents: function (Ls) {
        const meta = selfMeta(Ls);
        for (const ev of Object.keys(meta.events)) if (eventRegistry[ev]) eventRegistry[ev].delete(meta.id);
        meta.events = {};
        return 0;
      },
      GetName: function (Ls) {
        const meta = selfMeta(Ls);
        if (meta.name == null) lua.lua_pushnil(Ls);
        else lua.lua_pushstring(Ls, utf8ls(meta.name));
        return 1;
      },
      SetParent: function (Ls) {
        const meta = selfMeta(Ls);
        logRegion('SetParent', meta, Ls);
        return 0;
      },
      GetParent: function (Ls) {
        const meta = selfMeta(Ls);
        if (meta.parent) pushFrame(meta.parent); else lua.lua_pushnil(Ls);
        return 1;
      },
      // Frame:GetRegions —— 与真实 API 一致：返回**多个返回值（varargs）**，不是表。
      // （0.9.4 修复配套：被测代码曾按"表"接收导致兜底路径永远不执行，装置必须建模对。）
      GetRegions: function (Ls) {
        const m = selfMeta(Ls);
        const kids = Object.values(frames)
          .filter((f) => f.parent === m.id)
          .sort((a, b) => a.id - b.id);
        for (const k of kids) pushFrame(k.id);
        return kids.length;
      },
      // GameTooltip:GetItem —— 返回 (name, link)。链接由 setTooltipItemLink 预置；
      // 未预置视为 nil（与"当前不是物品提示框"一致，供 IsItemTooltip/物品 ID 比对用）
      GetItem: function (Ls) {
        const m = selfMeta(Ls);
        const link = (scenario.tooltipItemLinks || {})[m.id];
        if (link == null) { lua.lua_pushnil(Ls); lua.lua_pushnil(Ls); return 2; }
        lua.lua_pushstring(Ls, utf8ls(''));
        lua.lua_pushstring(Ls, utf8ls(link));
        return 2;
      },
      IsShown: function (Ls) { lua.lua_pushboolean(Ls, selfMeta(Ls).shown); return 1; },
      // SetHyperlink(link)：真实客户端会清空提示框并按新链接重建（重新走
      // TooltipDataProcessor 流程）。装置同样重放，用于验证"已显示提示框实时刷新"。
      SetHyperlink: function (Ls) {
        const m = selfMeta(Ls);
        const link = jsArg(Ls, 2);
        logRegion('SetHyperlink', m, Ls);
        if (typeof link !== 'string') return 0;
        scenario.tooltipItemLinks = scenario.tooltipItemLinks || {};
        scenario.tooltipItemLinks[m.id] = link;
        const idm = /item:(\d+)/.exec(link);
        if (idm) reRenderItemTooltip(m.id, Number(idm[1]));
        return 0;
      },
      SetShown: function (Ls) { selfMeta(Ls).shown = !!lua.lua_toboolean(Ls, 2); return 0; },
      Show: function (Ls) { selfMeta(Ls).shown = true; return 0; },
      Hide: function (Ls) { selfMeta(Ls).shown = false; return 0; },
      GetWidth: function (Ls) { lua.lua_pushnumber(Ls, selfMeta(Ls).w || 0); return 1; },
      GetHeight: function (Ls) { lua.lua_pushnumber(Ls, selfMeta(Ls).h || 0); return 1; },
      SetWidth: function (Ls) { selfMeta(Ls).w = lua.lua_tonumber(Ls, 2); return 0; },
      SetHeight: function (Ls) { selfMeta(Ls).h = lua.lua_tonumber(Ls, 2); return 0; },
      SetSize: function (Ls) { const m = selfMeta(Ls); m.w = lua.lua_tonumber(Ls, 2); m.h = lua.lua_tonumber(Ls, 3); return 0; },
      GetScale: function (Ls) { lua.lua_pushnumber(Ls, selfMeta(Ls).scale || 1); return 1; },
      SetScale: function (Ls) { selfMeta(Ls).scale = lua.lua_tonumber(Ls, 2); return 0; },
      GetAlpha: function (Ls) { lua.lua_pushnumber(Ls, selfMeta(Ls).alpha == null ? 1 : selfMeta(Ls).alpha); return 1; },
      SetAlpha: function (Ls) { selfMeta(Ls).alpha = lua.lua_tonumber(Ls, 2); return 0; },
      SetPoint: function (Ls) { const m = selfMeta(Ls); logRegion('SetPoint', m, Ls); return 0; },
      SetAllPoints: function (Ls) { const m = selfMeta(Ls); logRegion('SetAllPoints', m, Ls); return 0; },
      ClearAllPoints: function (Ls) { const m = selfMeta(Ls); logRegion('ClearAllPoints', m, Ls); return 0; },
      SetFrameStrata: function (Ls) { const m = selfMeta(Ls); logRegion('SetFrameStrata', m, Ls); return 0; },
      SetFrameLevel: function (Ls) { const m = selfMeta(Ls); logRegion('SetFrameLevel', m, Ls); return 0; },
      GetFrameLevel: function (Ls) { lua.lua_pushnumber(Ls, 0); return 1; },
      SetMovable: function (Ls) { const m = selfMeta(Ls); logRegion('SetMovable', m, Ls); return 0; },
      SetClampedToScreen: function (Ls) { const m = selfMeta(Ls); logRegion('SetClampedToScreen', m, Ls); return 0; },
      EnableMouse: function (Ls) { const m = selfMeta(Ls); logRegion('EnableMouse', m, Ls); return 0; },
      EnableMouseWheel: function (Ls) { const m = selfMeta(Ls); logRegion('EnableMouseWheel', m, Ls); return 0; },
      RegisterForClicks: function (Ls) { const m = selfMeta(Ls); logRegion('RegisterForClicks', m, Ls); return 0; },
      SetBackdrop: function (Ls) { const m = selfMeta(Ls); logRegion('SetBackdrop', m, Ls); return 0; },
      SetBackdropColor: function (Ls) { const m = selfMeta(Ls); logRegion('SetBackdropColor', m, Ls); return 0; },
      SetBackdropBorderColor: function (Ls) { const m = selfMeta(Ls); logRegion('SetBackdropBorderColor', m, Ls); return 0; },
      SetPadding: function (Ls) { const m = selfMeta(Ls); m.padding = lua.lua_tonumber(Ls, 2); logRegion('SetPadding', m, Ls); return 0; },
      CreateTexture: function (Ls) {
        const meta = selfMeta(Ls);
        logRegion('CreateTexture', meta, Ls);
        childCounter++;
        newRegion('texture', meta.name ? meta.name + 'Texture' + childCounter : null, meta.id);
        return 1;
      },
      CreateFontString: function (Ls) {
        const meta = selfMeta(Ls);
        logRegion('CreateFontString', meta, Ls);
        childCounter++;
        newRegion('fontstring', meta.name ? meta.name + 'FontString' + childCounter : null, meta.id);
        return 1;
      },
      CreateAnimationGroup: function (Ls) {
        const meta = selfMeta(Ls);
        logRegion('CreateAnimationGroup', meta, Ls);
        childCounter++;
        newRegion('animgroup', meta.name ? meta.name + 'Anim' + childCounter : null, meta.id);
        return 1;
      },
      NumLines: function (Ls) { lua.lua_pushinteger(Ls, selfMeta(Ls).numLines || 0); return 1; },
      AddLine: function (Ls) {
        const meta = selfMeta(Ls);
        const id = appendLine(meta, jsArg(Ls, 2) || '');
        logRegion('AddLine', meta, Ls);
        // 真实客户端里 AddLine 的返回值并不可靠（首行之外常拿不到 FontString）。
        // addLineNoReturn=true 用于模拟这种情形，迫使实现走"按行号扫描"的兜底路径。
        if (scenario.addLineNoReturn) return 0;
        pushFrame(id);
        return 1;
      },
      AddDoubleLine: function (Ls) {
        const meta = selfMeta(Ls);
        const N = (meta.numLines || 0) + 1;
        meta.numLines = N;
        const base = meta.name || 'Tooltip';
        const leftId = newRegion('fontstring', base + 'TextLeft' + N, meta.id);
        setRegionText(leftId, jsArg(Ls, 2) || '');
        lua.lua_pushvalue(Ls, -1);
        lua.lua_setglobal(Ls, to_luastring(base + 'TextLeft' + N));
        lua.lua_pop(Ls, 1);
        const rightId = newRegion('fontstring', base + 'TextRight' + N, meta.id);
        setRegionText(rightId, jsArg(Ls, 3) || '');
        lua.lua_pushvalue(Ls, -1);
        lua.lua_setglobal(Ls, to_luastring(base + 'TextRight' + N));
        lua.lua_pop(Ls, 1);
        pushFrame(leftId);
        logRegion('AddDoubleLine', meta, Ls);
        return 1;
      },
      SetText: function (Ls) { const m = selfMeta(Ls); m.text = jsArg(Ls, 2); logRegion('SetText', m, Ls); return 0; },
      // 粗略但确定的度量：空格 = 0.25 em，其它字符 = 0.5 em。
      // 足以验证"按像素对齐"这类算法（数字与空格宽度不同正是关键）。
      GetStringWidth: function (Ls) {
        const m = selfMeta(Ls);
        const size = (m.font && m.font.height) || 12;
        lua.lua_pushnumber(Ls, measureText(m.text, size));
        return 1;
      },
      SetChecked: function (Ls) { const m = selfMeta(Ls); m.checked = jsArg(Ls, 2) ? true : false; logRegion('SetChecked', m, Ls); return 0; },
      GetChecked: function (Ls) { const m = selfMeta(Ls); lua.lua_pushboolean(Ls, !!m.checked); return 1; },
      SetEnabled: function (Ls) { const m = selfMeta(Ls); m.enabled = jsArg(Ls, 2) ? true : false; logRegion('SetEnabled', m, Ls); return 0; },
      IsEnabled: function (Ls) { const m = selfMeta(Ls); lua.lua_pushboolean(Ls, m.enabled !== false); return 1; },
      // —— Slider（与游戏一致：SetValue 会触发 OnValueChanged）——
      SetMinMaxValues: function (Ls) { const m = selfMeta(Ls); m.minValue = lua.lua_tonumber(Ls, 2); m.maxValue = lua.lua_tonumber(Ls, 3); logRegion('SetMinMaxValues', m, Ls); return 0; },
      GetMinMaxValues: function (Ls) { const m = selfMeta(Ls); lua.lua_pushnumber(Ls, m.minValue || 0); lua.lua_pushnumber(Ls, m.maxValue || 0); return 2; },
      SetValueStep: function (Ls) { const m = selfMeta(Ls); m.valueStep = lua.lua_tonumber(Ls, 2); logRegion('SetValueStep', m, Ls); return 0; },
      GetValueStep: function (Ls) { const m = selfMeta(Ls); lua.lua_pushnumber(Ls, m.valueStep || 1); return 1; },
      SetObeyStepOnDrag: function (Ls) { const m = selfMeta(Ls); m.obeyStep = jsArg(Ls, 2) ? true : false; return 0; },
      SetValue: function (Ls) {
        const m = selfMeta(Ls);
        const v = lua.lua_tonumber(Ls, 2);
        m.value = v;
        logRegion('SetValue', m, Ls);
        const ref = m.scripts['OnValueChanged'];
        if (ref != null) {
          pushRef(ref);
          pushFrame(m.id);
          lua.lua_pushnumber(Ls, v);
          if (lua.lua_pcall(Ls, 2, 0, 0) !== lua.LUA_OK) {
            errors.push({ kind: 'script', error: jsstr(lua.lua_tolstring(Ls, -1)) });
            lua.lua_pop(Ls, 1);
          }
        }
        return 0;
      },
      GetValue: function (Ls) { const m = selfMeta(Ls); lua.lua_pushnumber(Ls, m.value || 0); return 1; },
      GetText: function (Ls) {
        const m = selfMeta(Ls);
        if (m.text == null) lua.lua_pushnil(Ls); else lua.lua_pushstring(Ls, utf8ls(m.text));
        return 1;
      },
      SetFont: function (Ls) {
        const m = selfMeta(Ls);
        m.font = { path: jsArg(Ls, 2), height: lua.lua_tonumber(Ls, 3), flags: jsArg(Ls, 4) || '' };
        logRegion('SetFont', m, Ls);
        return 0;
      },
      GetFont: function (Ls) {
        const m = selfMeta(Ls);
        const f = m.font || { path: null, height: 12, flags: '' };
        if (f.path == null) lua.lua_pushnil(Ls); else lua.lua_pushstring(Ls, utf8ls(f.path));
        lua.lua_pushnumber(Ls, f.height == null ? 12 : f.height);
        lua.lua_pushstring(Ls, utf8ls(f.flags || ''));
        return 3;
      },
      SetTextColor: function (Ls) { const m = selfMeta(Ls); logRegion('SetTextColor', m, Ls); return 0; },
      SetJustifyH: function (Ls) { const m = selfMeta(Ls); logRegion('SetJustifyH', m, Ls); return 0; },
      SetJustifyV: function (Ls) { const m = selfMeta(Ls); logRegion('SetJustifyV', m, Ls); return 0; },
      SetVertexColor: function (Ls) { const m = selfMeta(Ls); logRegion('SetVertexColor', m, Ls); return 0; },
      SetColorTexture: function (Ls) { const m = selfMeta(Ls); logRegion('SetColorTexture', m, Ls); return 0; },
      SetTexture: function (Ls) { const m = selfMeta(Ls); logRegion('SetTexture', m, Ls); return 0; },
      SetDrawLayer: function (Ls) { const m = selfMeta(Ls); logRegion('SetDrawLayer', m, Ls); return 0; },
      SetSpacing: function (Ls) { const m = selfMeta(Ls); logRegion('SetSpacing', m, Ls); return 0; },
      SetNonSpaceWrap: function (Ls) { const m = selfMeta(Ls); logRegion('SetNonSpaceWrap', m, Ls); return 0; },
      SetWordWrap: function (Ls) { const m = selfMeta(Ls); logRegion('SetWordWrap', m, Ls); return 0; },
      SetMaxLines: function (Ls) { const m = selfMeta(Ls); logRegion('SetMaxLines', m, Ls); return 0; },
      // 与真实 API 一致返回首字母大写的类型名（"Frame"/"FontString"/"Texture"），
      // 此前返回小写 kind，导致任何 `kind == "FontString"` 的比较在装置里恒假。
      GetObjectType: function (Ls) {
        const kind = selfMeta(Ls).kind;
        const names = { frame: 'Frame', fontstring: 'FontString', texture: 'Texture', animgroup: 'AnimationGroup' };
        lua.lua_pushstring(Ls, utf8ls(names[kind] || kind));
        return 1;
      },
      IsObjectType: function (Ls) { lua.lua_pushboolean(Ls, jsArg(Ls, 2) === selfMeta(Ls).kind); return 1; },
      SetDuration: function (Ls) { const m = selfMeta(Ls); logRegion('SetDuration', m, Ls); return 0; },
      Play: function (Ls) { const m = selfMeta(Ls); logRegion('Play', m, Ls); return 0; },
      Stop: function (Ls) { const m = selfMeta(Ls); logRegion('Stop', m, Ls); return 0; },
      Pause: function (Ls) { const m = selfMeta(Ls); logRegion('Pause', m, Ls); return 0; },
      SetLooping: function (Ls) { const m = selfMeta(Ls); logRegion('SetLooping', m, Ls); return 0; },
      SetIgnored: function (Ls) { return 0; },
      SetFramePoint: function (Ls) { const m = selfMeta(Ls); logRegion('SetFramePoint', m, Ls); return 0; },
    };
  }

  function registerRegionMethods() {
    lua.lua_createtable(L, 0, 0);
    const methods = buildRegionMethods();
    for (const name of Object.keys(methods)) {
      lua.lua_pushjsfunction(L, methods[name]);
      lua.lua_setfield(L, -2, to_luastring(name));
    }
    regionMethodsRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
  }

  function exposeRegionGlobal(name, id) {
    pushFrame(id);
    lua.lua_setglobal(L, to_luastring(name));
  }

  /* ------------------------- 事件 / 定时器 ------------------------- */
  function invokeRef(ref, frameId, event, args) {
    pushRef(ref);
    pushFrame(frameId);
    lua.lua_pushstring(L, utf8ls(event));
    for (const a of args) pushJsValue(L, a);
    const nargs = 2 + args.length;
    const cs = lua.lua_pcall(L, nargs, 0, 0);
    if (cs !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      errors.push({ kind: 'event', event, error: e });
      lua.lua_pop(L, 1);
    }
  }

  function fireEvent(event) {
    const args = Array.prototype.slice.call(arguments, 1);
    const set = eventRegistry[event];
    if (!set) return;
    for (const id of Array.from(set)) {
      const meta = frames[id];
      const h = meta.scripts.OnEvent;
      if (h != null) invokeRef(h, id, event, args);
      const hooks = meta.hooks.OnEvent || [];
      for (const hr of hooks) invokeRef(hr, id, event, args);
    }
  }

  function scheduleTimer(delay, fnRef) {
    const id = nextTimerId++;
    timers[id] = { delay, fnRef, remaining: delay, scheduledFor: scenario.clock + delay };
    return id;
  }

  function advanceTime(dt) {
    scenario.clock += dt;
    const due = [];
    for (const id of Object.keys(timers)) {
      const t = timers[id];
      t.remaining -= dt;
      if (t.remaining <= 0) due.push(id);
    }
    due.sort((a, b) => (timers[a].scheduledFor - timers[b].scheduledFor));
    for (const id of due) {
      const t = timers[id];
      if (!timers[id]) continue; // 已取消
      delete timers[id];
      pushRef(t.fnRef);
      const cs = lua.lua_pcall(L, 0, 0, 0);
      if (cs !== lua.LUA_OK) {
        const e = jsstr(lua.lua_tolstring(L, -1));
        errors.push({ kind: 'timer', error: e });
        lua.lua_pop(L, 1);
      }
      lauxlib.luaL_unref(L, lua.LUA_REGISTRYINDEX, t.fnRef);
    }
  }

  /* ------------------------- API 实现 ------------------------- */
  function unitSlot(Ls) {
    const n = lua.lua_gettop(Ls);
    if (n >= 2) return { unit: jsArg(Ls, 1), slot: lua.lua_tonumber(Ls, 2) };
    return { unit: 'player', slot: lua.lua_tonumber(Ls, 1) };
  }

  function buildGlobals() {
    const g = {};

    // —— 帧工厂 ——
    g.CreateFrame = function (Ls) {
      const frameType = jsArg(Ls, 1);
      const name = jsArg(Ls, 2) || null;
      const parent = jsArg(Ls, 3) || null;
      calls.push({ scope: 'api', name: 'CreateFrame', args: [frameType, name, parent] });
      const id = newRegion('frame', name, null);
      if (name) exposeRegionGlobal(name, id);
      return 1;
    };

    // —— C_Timer ——
    g.C_Timer = {
      NewTimer: function (Ls) {
        logApi('C_Timer.NewTimer', Ls);
        const delay = lua.lua_tonumber(Ls, 1);
        const fnRef = refArg(Ls, 2);
        const id = scheduleTimer(delay, fnRef);
        lua.lua_createtable(Ls, 0, 1);
        lua.lua_pushnumber(Ls, id); lua.lua_setfield(Ls, -2, to_luastring('__timerId'));
        lua.lua_pushjsfunction(Ls, function (LL) {
          lua.lua_getfield(LL, 1, to_luastring('__timerId'));
          const tid = lua.lua_tonumber(LL, -1);
          lua.lua_pop(LL, 1);
          if (timers[tid]) {
            lauxlib.luaL_unref(LL, lua.LUA_REGISTRYINDEX, timers[tid].fnRef);
            delete timers[tid];
          }
          return 0;
        });
        lua.lua_setfield(Ls, -2, to_luastring('Cancel'));
        return 1;
      },
      After: function (Ls) {
        logApi('C_Timer.After', Ls);
        const delay = lua.lua_tonumber(Ls, 1);
        const fnRef = refArg(Ls, 2);
        const id = scheduleTimer(delay, fnRef);
        lua.lua_createtable(Ls, 0, 1);
        lua.lua_pushnumber(Ls, id); lua.lua_setfield(Ls, -2, to_luastring('__timerId'));
        lua.lua_pushjsfunction(Ls, function (LL) {
          lua.lua_getfield(LL, 1, to_luastring('__timerId'));
          const tid = lua.lua_tonumber(LL, -1);
          lua.lua_pop(LL, 1);
          if (timers[tid]) { delete timers[tid]; }
          return 0;
        });
        lua.lua_setfield(Ls, -2, to_luastring('Cancel'));
        return 1;
      },
    };

    // —— C_Container ——
    g.C_Container = {
      GetContainerNumSlots: function (Ls) {
        logApi('C_Container.GetContainerNumSlots', Ls);
        const bag = lua.lua_tonumber(Ls, 1);
        const items = scenario.containers[bag];
        if (items == null) { lua.lua_pushnumber(Ls, 0); return 1; }   // 容器不存在
        // 真实客户端返回的是容器**容量**（空包也有槽），与内容无关；
        // containerSlots 可显式声明容量（如银行包栏 -4 恒为 7），缺省回落为条目数。
        const capacity = (scenario.containerSlots && scenario.containerSlots[bag]);
        lua.lua_pushnumber(Ls, capacity != null ? capacity : items.length);
        return 1;
      },
      GetContainerItemInfo: function (Ls) {
        logApi('C_Container.GetContainerItemInfo', Ls);
        const bag = lua.lua_tonumber(Ls, 1);
        const slot = lua.lua_tonumber(Ls, 2);
        const slots = scenario.containers[bag];
        const info = slots ? slots[slot - 1] : null;
        if (!info) { lua.lua_pushnil(Ls); return 1; }
        pushJsValue(Ls, {
          itemID: info.itemID, stackCount: info.stackCount, itemName: info.itemName,
          iconFileID: info.iconFileID, quality: info.quality,
        });
        return 1;
      },
      SortAccountBankBags: function (Ls) {
        logApi('C_Container.SortAccountBankBags', Ls);
        return 0;
      },
    };

    // —— C_Bank ——
    g.C_Bank = {
      FetchPurchasedBankTabIDs: function (Ls) {
        logApi('C_Bank.FetchPurchasedBankTabIDs', Ls);
        const bt = lua.lua_tonumber(Ls, 1);
        const arr = scenario.bankTabIDs[bt] || [];
        pushJsValue(Ls, arr);
        return 1;
      },
      FetchPurchasedBankTabData: function (Ls) {
        logApi('C_Bank.FetchPurchasedBankTabData', Ls);
        pushJsValue(Ls, {});
        return 1;
      },
      FetchNumPurchasedBankTabs: function (Ls) {
        logApi('C_Bank.FetchNumPurchasedBankTabs', Ls);
        const bt = lua.lua_tonumber(Ls, 1);
        lua.lua_pushnumber(Ls, (scenario.bankTabIDs[bt] || []).length);
        return 1;
      },
      CanViewBank: function (Ls) { lua.lua_pushboolean(Ls, true); return 1; },
      FetchDepositedMoney: function (Ls) { lua.lua_pushnumber(Ls, 0); return 1; },
    };

    // —— C_Item ——
    // 保真度铁律：装置只提供**真机存在**的 API。12.1.0 的 C_Item 里**没有**
    // GetEquippedCount（apidoc 12.1.0/12.0.7/11.2.7 零命中 + wiki 无页面，双源确认），
    // 所以这里也绝不再放这个桩——插件的已装备数必须靠 GetInventoryItemID 遍历装备槽得出。
    // （2026-09-30：此桩曾长期存在，导致"减装备数"的失效修复在 202/202 全绿下被掩盖。）
    g.C_Item = {
      // 与游戏一致：第 2/4/5 个布尔参数分别把银行 / 材料银行 / 战团银行计入。
      // 基准计数 = itemCount，按客户端口径**包含已装备**件数。
      GetItemCount: function (Ls) {
        logApi('C_Item.GetItemCount', Ls);
        const arg = jsArg(Ls, 1);
        const key = arg == null ? null : arg;
        let n = (key != null && scenario.itemCount[key]) || 0;
        if (lua.lua_toboolean(Ls, 2)) n += (scenario.itemCountBank && scenario.itemCountBank[key]) || 0;
        if (lua.lua_toboolean(Ls, 4)) n += (scenario.itemCountReagent && scenario.itemCountReagent[key]) || 0;
        if (lua.lua_toboolean(Ls, 5)) n += (scenario.itemCountAccount && scenario.itemCountAccount[key]) || 0;
        lua.lua_pushnumber(Ls, n);
        return 1;
      },
    };

    // —— Enum ——
    g.Enum = {
      BankType: { Character: 0, Guild: 1, Account: 2 },
      // 逐字照抄 12.1.0 apidoc 的 BagIndexConstantsDocumentation（20 个成员，MinValue=-3, MaxValue=16）。
      // 注意没有 BankBag —— 11.2.7 起就没有这个成员了，此处曾放过 `BankBag: -4` 的假成员，
      // 让插件里引用它的死代码在测试中"看起来能跑"。不要再加回来。
      BagIndex: {
        Accountbanktab: -3, Characterbanktab: -2, Keyring: -1,
        Backpack: 0, Bag_1: 1, Bag_2: 2, Bag_3: 3, Bag_4: 4, ReagentBag: 5,
        CharacterBankTab_1: 6, CharacterBankTab_2: 7, CharacterBankTab_3: 8,
        CharacterBankTab_4: 9, CharacterBankTab_5: 10, CharacterBankTab_6: 11,
        AccountBankTab_1: 12, AccountBankTab_2: 13, AccountBankTab_3: 14,
        AccountBankTab_4: 15, AccountBankTab_5: 16,
      },
      TooltipDataType: { Item: 1, Unit: 2, Coroutine: 3 },
      TooltipDataLineType: LINE_TYPES,
    };

    // —— TooltipDataProcessor ——
    g.TooltipDataProcessor = {
      AddTooltipPreCall: function (Ls) {
        logApi('TooltipDataProcessor.AddTooltipPreCall', Ls);
        const type = lua.lua_tonumber(Ls, 1);
        const ref = refArg(Ls, 2);
        (tooltipPreCall[type] = tooltipPreCall[type] || []).push(ref);
        return 0;
      },
      AddTooltipPostCall: function (Ls) {
        logApi('TooltipDataProcessor.AddTooltipPostCall', Ls);
        const type = lua.lua_tonumber(Ls, 1);
        const ref = refArg(Ls, 2);
        (tooltipPostCall[type] = tooltipPostCall[type] || []).push(ref);
        return 0;
      },
      AddLinePreCall: function (Ls) {
        logApi('TooltipDataProcessor.AddLinePreCall', Ls);
        const type = lua.lua_tonumber(Ls, 1);
        const ref = refArg(Ls, 2);
        (linePreCall[type] = linePreCall[type] || []).push(ref);
        return 0;
      },
      AddLinePostCall: function (Ls) {
        logApi('TooltipDataProcessor.AddLinePostCall', Ls);
        const type = lua.lua_tonumber(Ls, 1);
        const ref = refArg(Ls, 2);
        (linePostCall[type] = linePostCall[type] || []).push(ref);
        return 0;
      },
      RemoveTooltipPostCall: function (Ls) {
        logApi('TooltipDataProcessor.RemoveTooltipPostCall', Ls);
        return 0;
      },
    };

    // —— Settings / Menu / MenuUtil / UIDropDownMenu ——
    // 注意：必须传入当前 Lua state；此前该函数引用了不存在的 Ls，
    // 导致 Settings/MenuUtil 这批桩在 pcall 下静默失败（返回值错位）。
    function stubTable(state) { lua.lua_createtable(state, 0, 0); return 1; }
    g.Settings = {
      RegisterAddOnCategory: function (Ls) { logApi('Settings.RegisterAddOnCategory', Ls); return stubTable(Ls); },
      RegisterCanvasLayoutCategory: function (Ls) { logApi('Settings.RegisterCanvasLayoutCategory', Ls); return stubTable(Ls); },
      RegisterCanvasLayoutSubcategory: function (Ls) { logApi('Settings.RegisterCanvasLayoutSubcategory', Ls); return stubTable(Ls); },
      RegisterAddOnCategorySubcategory: function (Ls) { logApi('Settings.RegisterAddOnCategorySubcategory', Ls); return stubTable(Ls); },
      GetAddOnCategory: function (Ls) { return stubTable(Ls); },
      GetCanvasLayoutCategory: function (Ls) { return stubTable(Ls); },
      SetCanvasLayoutCategory: function (Ls) { return 0; },
    };
    g.MenuUtil = {
      CreateCheckbox: function (Ls) { logApi('MenuUtil.CreateCheckbox', Ls); return stubTable(Ls); },
      CreateButton: function (Ls) { logApi('MenuUtil.CreateButton', Ls); return stubTable(Ls); },
      CreateText: function (Ls) { logApi('MenuUtil.CreateText', Ls); return stubTable(Ls); },
      CreateContextMenu: function (Ls) { logApi('MenuUtil.CreateContextMenu', Ls); return stubTable(Ls); },
      CreateRadioButton: function (Ls) { logApi('MenuUtil.CreateRadioButton', Ls); return stubTable(Ls); },
    };
    g.Menu = {
      CreateContextMenu: function (Ls) { logApi('Menu.CreateContextMenu', Ls); return stubTable(Ls); },
    };
    g.UIDropDownMenuTemplate = {};
    g.UIDropDownMenu = {
      Initialize: function (Ls) { return 0; },
      Open: function (Ls) { return 0; },
      Close: function (Ls) { return 0; },
      SetupMenu: function (Ls) { return 0; },
      Refresh: function (Ls) { return 0; },
    };
    g.ColorPickerFrame = { OpenColorPicker: function (Ls) { return 0; } };

    // —— LibStub（返回 nil，模拟未安装任何库）——
    g.LibStub = function (Ls) { logApi('LibStub', Ls); lua.lua_pushnil(Ls); return 1; };

    // —— 全局函数 ——
    g.time = function (Ls) { lua.lua_pushnumber(Ls, scenario.clock); return 1; };
    g.GetLocale = function (Ls) { lua.lua_pushstring(Ls, utf8ls(scenario.locale)); return 1; };
    g.GetMoney = function (Ls) { lua.lua_pushnumber(Ls, scenario.money || 0); return 1; };
    g.UnitClass = function (Ls) {
      const p = scenario.player;
      lua.lua_pushstring(Ls, utf8ls(p.localizedClass || p.class));
      lua.lua_pushstring(Ls, utf8ls(p.class));
      lua.lua_pushnumber(Ls, p.classID || 1);
      return 3;
    };
    g.UnitFactionGroup = function (Ls) { lua.lua_pushstring(Ls, utf8ls(scenario.player.faction || 'Alliance')); return 1; };
    g.UnitFullName = function (Ls) {
      const p = scenario.player;
      lua.lua_pushstring(Ls, utf8ls(p.name));
      lua.lua_pushstring(Ls, utf8ls(p.realm));
      return 2;
    };
    g.UnitName = function (Ls) { lua.lua_pushstring(Ls, utf8ls(scenario.player.name)); return 1; };
    g.UnitExists = function (Ls) { lua.lua_pushboolean(Ls, true); return 1; };

    // FrameXML 的装备槽常量（真机由 FrameXML 提供；插件对缺失有兜底，但装置应给真的）
    g.INVSLOT_FIRST_EQUIPPED = 1;
    g.INVSLOT_LAST_EQUIPPED = 19;

    g.GetInventoryItemID = function (Ls) {
      const us = unitSlot(Ls);
      const info = scenario.equip[us.slot];
      if (!info || info.itemID == null) lua.lua_pushnil(Ls); else lua.lua_pushnumber(Ls, info.itemID);
      return 1;
    };
    g.GetInventoryItemLink = function (Ls) {
      const us = unitSlot(Ls);
      const info = scenario.equip[us.slot];
      if (!info || !info.link) lua.lua_pushnil(Ls); else lua.lua_pushstring(Ls, utf8ls(info.link));
      return 1;
    };
    g.GetInventoryItemTexture = function (Ls) {
      const us = unitSlot(Ls);
      const info = scenario.equip[us.slot];
      if (!info || !info.texture) lua.lua_pushnil(Ls); else lua.lua_pushstring(Ls, utf8ls(info.texture));
      return 1;
    };
    g.GetInventoryItemQuality = function (Ls) {
      const us = unitSlot(Ls);
      const info = scenario.equip[us.slot];
      if (!info || info.quality == null) lua.lua_pushnil(Ls); else lua.lua_pushnumber(Ls, info.quality);
      return 1;
    };

    g.GetItemInfo = function (Ls) {
      logApi('GetItemInfo', Ls);
      const id = lua.lua_tonumber(Ls, 1);
      const m = scenario.itemMeta[id];
      if (!m) { lua.lua_pushnil(Ls); return 1; }
      lua.lua_pushstring(Ls, utf8ls(m.name || ('Item' + id)));
      lua.lua_pushstring(Ls, utf8ls('item:' + id + ':0:0:0:0:0:0:0'));
      lua.lua_pushnumber(Ls, m.quality || 1);
      lua.lua_pushnumber(Ls, 1);
      lua.lua_pushnumber(Ls, 1);
      lua.lua_pushstring(Ls, utf8ls(''));
      lua.lua_pushstring(Ls, utf8ls(''));
      lua.lua_pushnumber(Ls, 1);
      lua.lua_pushstring(Ls, utf8ls(''));
      lua.lua_pushnumber(Ls, m.icon || 0);
      return 10;
    };

    g.print = function (Ls) {
      const n = lua.lua_gettop(Ls);
      const parts = [];
      for (let i = 1; i <= n; i++) {
        const t = lua.lua_type(Ls, i);
        if (t === lua.LUA_TNIL) parts.push('nil');
        else if (t === lua.LUA_TSTRING) parts.push(jsstr(lua.lua_tolstring(Ls, i)));
        else if (t === lua.LUA_TNUMBER) parts.push(String(lua.lua_tonumber(Ls, i)));
        else if (t === lua.LUA_TBOOLEAN) parts.push(lua.lua_toboolean(Ls, i) ? 'true' : 'false');
        else parts.push(jsArg(Ls, i));
      }
      printLog.push(parts.join('\t'));
      return 0;
    };

    g.hooksecurefunc = function (Ls) {
      logApi('hooksecurefunc', Ls);
      const method = jsArg(Ls, 2);
      const ref = refArg(Ls, 3);
      secureHooks.push({ table: jsArg(Ls, 1), method, hookRef: ref });
      return 0;
    };

    // —— 斜杠命令：模拟客户端的注册链路 SLASH_<KEY><n> → SlashCmdList[<KEY>] ——
    // 装置不再预置 SLASH_STACKLEDGER1 / SLASH_SL1 这类历史残留（它们既不属于当前插件，
    // 又会让"注册到底对不对"永远查不出来）。测试改用 invokeSlashCommand('/st')，
    // 它像客户端一样只认插件自己写进 _G 的 SLASH_* 全局。
    g.SlashCmdList = {};

    // —— RAID_CLASS_COLORS ——
    const classColors = {};
    const cc = {
      WARRIOR: [0.78, 0.61, 0.43, 'ffc79c6e'],
      PALADIN: [0.96, 0.55, 0.73, 'fff58cba'],
      HUNTER: [0.67, 0.83, 0.45, 'ffabd473'],
      ROGUE: [1.00, 0.96, 0.41, 'fffff569'],
      PRIEST: [1.00, 1.00, 1.00, 'ffffffff'],
      DEATHKNIGHT: [0.77, 0.12, 0.23, 'ffc41f3b'],
      SHAMAN: [0.00, 0.44, 0.87, 'ff0070de'],
      MAGE: [0.41, 0.80, 0.94, 'ff69ccf0'],
      WARLOCK: [0.58, 0.51, 0.79, 'ff9482c9'],
      MONK: [0.00, 1.00, 0.59, 'ff00ff96'],
      DRUID: [1.00, 0.49, 0.04, 'ffff7d0a'],
      DEMONHUNTER: [0.64, 0.19, 0.79, 'ffa330c9'],
      EVOKER: [0.20, 0.58, 0.50, 'ff33937f'],
    };
    for (const k of Object.keys(cc)) {
      classColors[k] = { r: cc[k][0], g: cc[k][1], b: cc[k][2], colorStr: cc[k][3] };
    }
    g.RAID_CLASS_COLORS = classColors;

    return g;
  }

  /* ------------------------- 装配全局 ------------------------- */
  registerRegionMethods();
  const globals = buildGlobals();
  for (const name of Object.keys(globals)) {
    setGlobal(name, globals[name]);
  }

  // 预置常用帧/字体
  const uiParent = newRegion('frame', 'UIParent', null); lua.lua_pop(L, 1);
  exposeRegionGlobal('UIParent', uiParent);
  const gameTooltip = newRegion('tooltip', 'GameTooltip', uiParent); lua.lua_pop(L, 1);
  exposeRegionGlobal('GameTooltip', gameTooltip);
  const itemRefTooltip = newRegion('tooltip', 'ItemRefTooltip', uiParent); lua.lua_pop(L, 1);
  exposeRegionGlobal('ItemRefTooltip', itemRefTooltip);
  const gameFontNormal = newRegion('font', 'GameFontNormal', null); lua.lua_pop(L, 1);
  frames[gameFontNormal].font = { path: 'Fonts\\FRIZQT__.TTF', height: 12, flags: '' };
  exposeRegionGlobal('GameFontNormal', gameFontNormal);
  const gameFontSmall = newRegion('font', 'GameFontNormalSmall', null); lua.lua_pop(L, 1);
  frames[gameFontSmall].font = { path: 'Fonts\\FRIZQT__.TTF', height: 10, flags: '' };
  exposeRegionGlobal('GameFontNormalSmall', gameFontSmall);
  const gameFontLarge = newRegion('font', 'GameFontNormalLarge', null); lua.lua_pop(L, 1);
  frames[gameFontLarge].font = { path: 'Fonts\\FRIZQT__.TTF', height: 14, flags: '' };
  exposeRegionGlobal('GameFontNormalLarge', gameFontLarge);

  // —— 注入 WoW 专用纯 Lua 辅助（wipe/tinsert/strsplit/strjoin/format/unpack）——
  const bootstrap = [
    'function _sl_wipe(t) for k in pairs(t) do t[k] = nil end return t end _G.wipe = _sl_wipe',
    '_G.tinsert = table.insert',
    '_G.tremove = table.remove',
    '_G.tContains = function(t,v) for i=1,#t do if t[i]==v then return true end end return false end',
    '_G.format = string.format',
    '_G.strjoin = function(sep, ...) return table.concat({...}, sep) end',
    '_G.strsplit = function(sep, str, maxSplit) if sep == nil or str == nil then return nil end if sep == "" then return str end local out = {} local start = 1 while true do local p = string.find(str, sep, start, true) if not p then break end out[#out+1] = string.sub(str, start, p-1) start = p + #sep if maxSplit and #out >= maxSplit then break end end out[#out+1] = string.sub(str, start) return table.unpack(out, 1, #out) end',
    '_G.unpack = table.unpack',
    '_G.IsAddOnLoaded = function() return false end',
    '_G.GetAddOnMetadata = function() return nil end',
  ].join('\n');
  runLuaCode(bootstrap);

  /* ------------------------- 公开 API ------------------------- */
  function runLuaCode(code, chunkName) {
    const st = lauxlib.luaL_loadstring(L, utf8ls(code));
    if (st !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    const cs = lua.lua_pcall(L, 0, 0, 0);
    if (cs !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    return { ok: true };
  }

  function loadFile(filePath, chunkName, addonName, addonTableRef) {
    const fs = require('fs');
    let src;
    try { src = fs.readFileSync(filePath, 'utf8'); }
    catch (e) { return { ok: false, error: 'read error: ' + e.message }; }
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    const st = lauxlib.luaL_loadstring(L, utf8ls(src));
    if (st !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    // 推入 (addonName, addonTable) 两个 vararg
    lua.lua_pushstring(L, utf8ls(addonName));
    if (addonTableRef == null) lua.lua_pushnil(L); else pushRef(addonTableRef);
    const cs = lua.lua_pcall(L, 2, 0, 0);
    if (cs !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    return { ok: true };
  }

  // 创建 addon 共享表并作为全局（模拟客户端 _G[addonName] = {}）
  function makeAddonTable(addonName) {
    lua.lua_createtable(L, 0, 0);
    const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
    pushRef(ref);
    lua.lua_setglobal(L, to_luastring(addonName));
    return ref;
  }

  function getAddonTableRef(addonName) {
    lua.lua_getglobal(L, to_luastring(addonName));
    if (lua.lua_type(L, -1) === lua.LUA_TTABLE) {
      const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
      return ref;
    }
    lua.lua_pop(L, 1);
    return makeAddonTable(addonName);
  }

  function evalLua(code) {
    const st = lauxlib.luaL_loadstring(L, utf8ls(code));
    if (st !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    const cs = lua.lua_pcall(L, 0, 1, 0);
    if (cs !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    const v = luaToJs(L, -1);
    lua.lua_pop(L, 1);
    return { ok: true, value: v };
  }

  function evalMany(code) {
    const st = lauxlib.luaL_loadstring(L, utf8ls(code));
    if (st !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    const cs = lua.lua_pcall(L, 0, -1, 0); // LUA_MULTRET
    if (cs !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    const n = lua.lua_gettop(L);
    const values = [];
    for (let i = 1; i <= n; i++) values.push(luaToJs(L, i));
    lua.lua_settop(L, 0);
    return { ok: true, values };
  }

  function callGlobal(name) {
    const args = Array.prototype.slice.call(arguments, 1);
    lua.lua_getglobal(L, to_luastring(name));
    if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) {
      lua.lua_pop(L, 1);
      return { ok: false, error: 'not a function: ' + name };
    }
    for (const a of args) pushJsValue(L, a);
    const cs = lua.lua_pcall(L, args.length, 1, 0);
    if (cs !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 1);
      return { ok: false, error: e };
    }
    const v = luaToJs(L, -1);
    lua.lua_pop(L, 1);
    return { ok: true, value: v };
  }

  // 便捷：往 SlashCmdList 注册 / 调用
  function invokeSlash(cmd, msg) {
    lua.lua_getglobal(L, to_luastring('SlashCmdList'));
    if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) { lua.lua_pop(L, 1); return { ok: false, error: 'SlashCmdList not a table' }; }
    lua.lua_getfield(L, -1, to_luastring(cmd));
    if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) { lua.lua_pop(L, 2); return { ok: false, error: 'no slash handler: ' + cmd }; }
    lua.lua_pushstring(L, utf8ls(msg == null ? '' : msg));
    const cs = lua.lua_pcall(L, 1, 0, 0);
    if (cs !== lua.LUA_OK) {
      const e = jsstr(lua.lua_tolstring(L, -1));
      lua.lua_pop(L, 2);
      return { ok: false, error: e };
    }
    lua.lua_pop(L, 1);
    return { ok: true };
  }

  /**
   * 端到端斜杠命令：模拟客户端"用户敲 /xxx"的解析——
   * 枚举 _G 里的 SLASH_<KEY><n> 全局找到匹配的别名，再调 SlashCmdList[<KEY>]。
   * 这样"注册错键名/写错别名/忘了注册"都会被测出来（invokeSlash 直调键名做不到）。
   */
  function invokeSlashCommand(token, msg) {
    const t = String(token == null ? '' : token).replace(/^\//, '').toLowerCase();
    if (!t) return { ok: false, error: 'empty command' };
    lua.lua_pushglobaltable(L);
    lua.lua_pushnil(L);
    let foundKey = null;
    while (lua.lua_next(L, -2) !== 0) {
      if (lua.lua_type(L, -2) === lua.LUA_TSTRING) {
        const name = jsstr(lua.lua_tolstring(L, -2));
        const m = /^SLASH_([A-Za-z0-9_]+?)(\d+)$/.exec(name);
        if (m && lua.lua_type(L, -1) === lua.LUA_TSTRING) {
          const alias = jsstr(lua.lua_tolstring(L, -1));
          if (alias.toLowerCase() === '/' + t) foundKey = m[1];
        }
      }
      lua.lua_pop(L, 1);
    }
    lua.lua_pop(L, 1);
    if (!foundKey) return { ok: false, error: 'no slash alias registered for /' + t };
    const r = invokeSlash(foundKey, msg);
    return r.ok ? { ok: true, key: foundKey } : r;
  }

  // 触发 tooltip PostCall handler（type 默认 Item=1）
  function invokeTooltipPostCall(type, tooltipFrameId, data) {
    const list = tooltipPostCall[type] || [];
    for (const ref of list) {
      pushRef(ref);
      pushFrame(tooltipFrameId);
      pushJsValue(L, data);
      const cs = lua.lua_pcall(L, 2, 0, 0);
      if (cs !== lua.LUA_OK) {
        const e = jsstr(lua.lua_tolstring(L, -1));
        errors.push({ kind: 'tooltip', error: e });
        lua.lua_pop(L, 1);
      }
    }
  }

  function invokeTooltipPreCall(type, tooltipFrameId, data) {
    for (const ref of (tooltipPreCall[type] || [])) {
      pushRef(ref);
      pushFrame(tooltipFrameId);
      pushJsValue(L, data);
      if (lua.lua_pcall(L, 2, 0, 0) !== lua.LUA_OK) {
        errors.push({ kind: 'tooltipPre', error: jsstr(lua.lua_tolstring(L, -1)) });
        lua.lua_pop(L, 1);
      }
    }
  }

  function invokeLinePostCall(lineType, tooltipFrameId, lineData) {
    for (const ref of (linePostCall[lineType] || [])) {
      pushRef(ref);
      pushFrame(tooltipFrameId);
      pushJsValue(L, lineData);
      if (lua.lua_pcall(L, 2, 0, 0) !== lua.LUA_OK) {
        errors.push({ kind: 'linePost', error: jsstr(lua.lua_tolstring(L, -1)) });
        lua.lua_pop(L, 1);
      }
    }
  }

  // 派发某个 frame 上 SetScript 登记的脚本（如 OnShow/OnHide）。
  // 与真实客户端一致：HookScript 注册的同名钩子也会被派发（脚本先、钩子后）——
  // 插件的 EnsureShowHook 走的就是 HookScript，装置不派发钩子会让"显示态"相关
  // 逻辑（字号、实时刷新）永远走不到。
  function dispatchScript(frameId, scriptName) {
    const m = frames[frameId];
    if (!m) return;
    const run = (ref) => {
      pushRef(ref);
      pushFrame(frameId);
      if (lua.lua_pcall(L, 1, 0, 0) !== lua.LUA_OK) {
        errors.push({ kind: 'script:' + scriptName, error: jsstr(lua.lua_tolstring(L, -1)) });
        lua.lua_pop(L, 1);
      }
    };
    const ref = m.scripts[scriptName];
    if (ref != null) run(ref);
    for (const hr of (m.hooks[scriptName] || [])) run(hr);
  }

  /**
   * 模拟客户端完整的物品提示框流程（对齐官方 TooltipDataHandler:ProcessInfo）：
   *   tooltipPreCall → 逐行 [加行 + linePostCall] → tooltipPostCall → OnShow
   * lineSpecs: [{ type: 'ItemName'|'ItemLevel'|..., text, rightText }]
   * 关键保真点：
   *   - data.lines 的元素与传给行回调的 lineData 是**同一个 JS 对象**（配合 pushJsValue
   *     的同一性缓存 → Lua 侧是同一张表），被测代码的 "lineData == lastLine" 主判据可触发；
   *   - 自动预置 GetItem 链接（可用 setTooltipItemLink 覆盖/清除）；
   *   - 结束时派发 OnShow（真实流程是 ProcessInfo → Show）。
   */
  function invokeItemTooltipFlow(tooltipFrameId, data, lineSpecs) {
    const meta = frames[tooltipFrameId];
    if (!meta) return [];

    const specs = lineSpecs || [];
    const lineTypes = LINE_TYPES;
    const lineObjs = specs.map((s) => ({
      type: lineTypes[s.type] || 0,
      leftText: s.text || '',
      rightText: s.rightText || '',
      lineIndex: 0,
    }));
    const fullData = Object.assign({}, data || {}, { lines: lineObjs });
    if (fullData.id != null) {
      scenario.tooltipItemLinks = scenario.tooltipItemLinks || {};
      if (scenario.tooltipItemLinks[tooltipFrameId] == null) {
        scenario.tooltipItemLinks[tooltipFrameId] = 'item:' + fullData.id + '::::::::::::::';
      }
    }

    invokeTooltipPreCall(1, tooltipFrameId, fullData);

    for (let i = 0; i < specs.length; i++) {
      appendLine(meta, specs[i].text == null ? '' : specs[i].text);
      lineObjs[i].lineIndex = meta.numLines;    // 仅供日志/兜底判据参考
      invokeLinePostCall(lineObjs[i].type, tooltipFrameId, lineObjs[i]);
    }

    invokeTooltipPostCall(1, tooltipFrameId, fullData);
    meta.shown = true;                         // 真实流程末尾是 Show()：先置显示态，再派发 OnShow
    dispatchScript(tooltipFrameId, 'OnShow');

    return readLinesOf(tooltipFrameId);
  }

  // 读取某个提示框当前所有行的文本（按行号）
  // 注意：重建（SetHyperlink）后同名区域会有新旧两份，必须取**最新创建**的那个，
  // 否则断言读到的是上一轮遗留的旧文本（假绿）。
  function readLinesOf(tooltipFrameId) {
    const meta = frames[tooltipFrameId];
    const base = meta && meta.name ? meta.name : 'Tooltip';
    const newest = {};
    for (const f of Object.values(frames)) {
      if (!f || !f.name) continue;
      const m = new RegExp('^' + base + 'Text(Left|Right)(\\d+)$').exec(f.name);
      if (!m) continue;
      const n = parseInt(m[2], 10);
      const side = m[1];
      const cur = newest[n] && newest[n][side];
      if (!cur || f.id > cur.id) {
        newest[n] = newest[n] || {};
        newest[n][side] = f;
      }
    }
    const out = [];
    for (let i = 1; i <= (meta ? meta.numLines || 0 : 0); i++) {
      const pair = newest[i];
      const left = pair && pair.Left;
      const right = pair && pair.Right;
      out.push((left && left.text != null ? String(left.text) : '') +
               (right && right.text != null ? String(right.text) : ''));
    }
    return out;
  }

  // 重放一个物品提示框（对应真实客户端 SetHyperlink 的"清空并重建"）
  function reRenderItemTooltip(frameId, itemID) {
    const meta = frames[frameId];
    if (!meta) return;
    meta.numLines = 0;                          // 清空既有行（旧区域留在 frames 里但不再被引用）
    invokeItemTooltipFlow(frameId, { id: itemID }, [{ type: 'ItemName', text: 'Item' + itemID }]);
  }

  return {
    L, lua, lauxlib, scenario, calls, errors, printLog,
    // 帧
    frames, uiParent, gameTooltip, itemRefTooltip,
    // 事件 / 定时
    fireEvent, advanceTime,
    // Lua 桥
    runLuaCode, loadFile, evalLua, evalMany, callGlobal, getGlobal, setGlobal,
    pushJsValue, luaToJs, jsArg, utf8ls, jsstr,
    // addon 表
    makeAddonTable, getAddonTableRef, pushRef,
    // 便捷
    invokeSlash, invokeSlashCommand, invokeTooltipPostCall, invokeItemTooltipFlow,
    invokeTooltipPreCall, invokeLinePostCall, dispatchScript,
    setTooltipItemLink(frameId, link) {
      scenario.tooltipItemLinks = scenario.tooltipItemLinks || {};
      if (link == null) { delete scenario.tooltipItemLinks[frameId]; }
      else { scenario.tooltipItemLinks[frameId] = link; }
    },
    // 场景辅助
    setContainer(bagID, items) { scenario.containers[bagID] = items || []; },
    setEquip(slot, info) { scenario.equip[slot] = info; },
    setBankTabs(bankType, ids) { scenario.bankTabIDs[bankType] = ids; },
    setItemMeta(id, meta) { scenario.itemMeta[id] = meta; },
    setItemCount(id, count) { scenario.itemCount[id] = count; },
    // 让 itemID 恰好占据 count 个装备槽（自 1 号槽起找空位），并清掉其它持有它的槽。
    // 已装备态只认 scenario.equip（= 真机 GetInventoryItemID 的数据源），不再有并行计数模型。
    setEquipped(itemID, count) {
      for (const k of Object.keys(scenario.equip)) {
        if (scenario.equip[k] && scenario.equip[k].itemID === itemID) delete scenario.equip[k];
      }
      let placed = 0;
      for (let slot = 1; slot <= 19 && placed < count; slot++) {
        if (!scenario.equip[slot]) { scenario.equip[slot] = { itemID }; placed++; }
      }
      return placed;
    },
    setItemCountBank(id, count) { scenario.itemCountBank[id] = count; },
    setItemCountReagent(id, count) { scenario.itemCountReagent[id] = count; },
    setItemCountAccount(id, count) { scenario.itemCountAccount[id] = count; },
    frameById(id) { return frames[id]; },
    frameByName(name) {
      for (const id of Object.keys(frames)) if (frames[id].name === name) return frames[id];
      return null;
    },
  };
}

module.exports = { createWowMock, defaultScenario, measureText };
