# 审计 C —— 测试套件与模拟装置保真度

> 审计员：C（独立）
> 对象：`tools/wow-mock.js`（装置）、`tools/simple-smoke.js`（89 用例）、`tools/api-audit.js`、`tools/lua-check.js`
> 被测插件：`D:\Game\World of Warcraft\_retail_\Interface\AddOns\StackLedger\`（v0.7.0，5 文件）
> 基准：`reports/audit-v07/需求清单-审计用.md` §B/§D/§E
> 现场复核：`simple-smoke.js` = **89/89 通过**；`api-audit.js` = **0 ERROR / 0 WARN**；`lua-check.js` = **5/5 通过**（当前全绿，见文末"已核对无问题"）

---

## ⚠️ 0. 审计期间装置被并发修改（重要，Lead 请先读）

我在审计过程中（约 30 分钟内）观察到 `wow-mock.js` **在我两次读取之间被改动**：

- 首次读取：文件 **1199 行**，`buildRegionMethods` 内存在 **4 个同名方法重复定义**——`GetName`(331/437)、`GetParent`(342/439)、`GetStringWidth`(429/496)、`GetObjectType`(438/502)。
- 随后 grep + 复读：文件 **1190 行**，这 4 处重复定义**已全部被删除**（正好 9 行差异）。

**结论**：历史缺陷 D6（"GetStringWidth 被重复定义覆盖"）在审计窗口内被（他人）修复并清理了全部重复定义。当前文件**已无同名方法重复定义**（已逐个 grep 全部 70 个 region 方法名核对）。但请 Lead **确认这次改动是谁做的、是否有对应回归记录**——其它审计员若引用旧行号会全部错位（本报告行号以当前 1190 行版本为准）。

---

## 1. 装置与真实客户端偏差清单

> 影响标注：**假绿** = 测试通过但真实客户端可能仍坏；**假红** = 测试会误报失败（真实客户端其实正常）；**盲区** = 路径完全没被装置覆盖。

### F1【假绿 · P1】`measureText` 的 0.25em/0.5em 均匀度量模型，使 4f「括号对齐」断言成为闭环恒真

- **证据**：`wow-mock.js:42-49` 定义 `measureText`：空格=0.25em，其它字符一律=0.5em，且不区分 CJK/拉丁/数字。`wow-mock.js:429-434` 的 `GetStringWidth` 直接调它。测试 `simple-smoke.js:354-364` 的 `parenX` 也调**同一个** `measureText`（`simple-smoke.js:15` 导入）。即：**被测实现（经 mock 的 GetStringWidth）与断言量宽用的是同一个函数**。
- **影响（假绿）**：4f 的断言验证的是"插件补白算法在 mock 的均匀模型下自洽"，而不是"在真实比例字体下对齐"。真实 `FRIZQT__` 是比例字体：CJK 全角≈1.0em、拉丁≈0.5em、数字≈0.5em、空格≈0.25em。mock 把 CJK 当 0.5em，而 4f 里"霜火之誓/铁炉守卫"正是 CJK 名，真实宽度会是 mock 的约 2 倍，补白量也随之完全错误。**测试全绿，但游戏里括号很可能对不齐**——这正是题目问的"对齐断言结论是否失真"，答案是**是，已失真**。
- 4f 的"反例成立"（`simple-smoke.js:361-364`，去掉补白后 spread>一个空格）只证明了"补白确实改变了宽度"，不能证明"补白量在真实字体下正确"。
- **建议**：给 `measureText` 换成**真实字符宽度表**（CJK=1.0em、ASCII=0.5em、空格=0.25em、标点分别给值），或至少让 CJK 走全角。再补一条断言：用"霜火之誓"这类 CJK 名 + 拉丁名混合，验证按真实字宽补白后 spread ≤ 一个空格。**这是最该补的测试之一。**

### F2【假绿 · P2】`C_Item.GetItemCount` 装置内建了 5 参语义，E5 风险不可证伪

- **证据**：`wow-mock.js:695-706` 的 `GetItemCount` 把第 2/4/5 参分别映射到 `itemCountBank`/`itemCountReagent`/`itemCountAccount`（注释 703 明确"第 2/4/5 个布尔参数…"）。测试 `simple-smoke.js:188-190` 据此断言"战团并入银、不出现战团字样"。
- **影响（假绿）**：装置**假设** 12.1.0 客户端 `C_Item.GetItemCount` 支持 `includeAccountBank`（第 5 参）。若真实客户端实际上不支持（E5 疑点），"银"会少算战团部分，但测试依旧全绿。装置把"待验证的假设"当成了"已成立的事实"，等于替 E5 背书。
- **建议**：E5 需 live 源码级证据单独闭环；测试侧至少应加一条"装置自证"：当只设 `itemCountAccount` 时 `GetItemCount(id,false,false,false,false)` 必须等于 0（验证第 5 参**不是**被默认真——否则说明 mock 语义错）。

### F3【假绿 · P2】mock 的 `lineData` 每次新建对象，`lineData == p.lastLine` 同一性分支从未被触发

- **证据**：`wow-mock.js:1112-1114` 构造 `fullData.lines = specs.map(...)`（新建对象数组）；`wow-mock.js:1130` 构造 `lineData = {type,leftText,rightText,lineIndex}`（又一批**新对象**）。而插件 `Tooltip.lua:314-320` 的 `IsLastNativeLine` 有两个判据：
  1. `lineData == p.lastLine`（**同一张 Lua 表**的引用相等，官方行为）；
  2. 兜底 `lineIndex == p.lineCount`。
- **影响（假绿/盲区）**：mock 里 `data.lines[#lines]` 与逐行回调的 `lineData` 是**不同** JS 对象 → pushJsValue 各自压成不同 Lua 表 → `==` 恒为 false。**主判据（1）在 89 个用例里一次都没被跑到**，插入位置全靠兜底判据（2）验证。若主判据在真实客户端有 bug（如 lastLine 实际不是同一引用），测试不会发现。
- **建议**：`invokeItemTooltipFlow` 里让 `fullData.lines[i]` 与 `linePostCall` 的 `lineData` **复用同一对象**（先建 lineData，再据此组 lines），使同一性分支真正被触发；再补一条断言区分"命中同一性"与"命中 lineIndex"两条路径。

### F4【假绿 · P2】装置行号 1:1 干净计数 + 无 append 模式，掩盖 E1/E2 插入错位风险

- **证据**：`wow-mock.js:396` `NumLines` 直接返回 `meta.numLines`（严格等于 AddLine 次数）；`invokeItemTooltipFlow`（1106-1146）只模拟 `preCall → 逐行[加行+linePostCall] → postCall` 的单次完整流程，**没有 append 模式**（`info.append`）、没有 `excludeLines`、没有 `linePreCall`（`AddLinePreCall` 在 739 注册但流程里从不调用）。
- **影响（假绿/盲区）**：E1（pending 残留 → 单位提示框误插）与 E2（append 模式把追加段误判为原生最后一行）都无法用装置构造。因为 mock 的行号永远"恰好等于原生行数"，`lineIndex == p.lineCount` 永远在正确位置命中，插件 `OnAnyLine` 的错误插入路径完全不可见。
- **建议**：见盲区 B4/B9，需给装置补 `invokeTooltipPreCall` / `invokeLinePostCall` 粒度接口与 `append` 字段支持。

### F5【假红·潜在 · P3】mock 缺 `SetOwner`/`GetItem`/`GetRegions`/`SetHyperlink`，一旦加悬停/非物品/聊天链接测试会误报失败

- **证据**：`buildRegionMethods`（277-501）没有 `SetOwner`、`GetItem`、`GetRegions`、`SetHyperlink`。但插件确实用到：
  - `Options.lua:66` `GameTooltip:SetOwner(...)`（悬停 OnEnter）；
  - `Tooltip.lua:185-186` `tooltip:GetItem()`（`IsItemTooltip`）；
  - `Tooltip.lua:138-151` `tooltip:GetRegions()`（ApplyTooltipFont 兜底路径）；
  - `EnsureShowHook(ItemRefTooltip)`（`Tooltip.lua:204`）依赖 `SetHyperlink` 触发聊天链接流程。
- **影响**：当前全绿是因为这些分支都**没被走到**（OnShow/OnHide 从不派发、悬停从不触发、无聊天链接用例）。若任何人补这类测试，`SetOwner` 等 nil 方法会抛"attempt to call a nil value"→ **假红**（真实客户端是好的）。
- **建议**：补 `SetOwner`（空操作即可）、`GetItem`（返回可控 link，用于 `IsItemTooltip` 真/假两分支）、`GetRegions`（返回 FontString 列表）、`SetHyperlink`（触发 item 数据 + OnShow）。见盲区 B1/B8。

### F6【盲区 · P3】`GetObjectType` 返回小写 kind，与真实 "FontString" 大小写不一致

- **证据**：`wow-mock.js:493` `GetObjectType` 返回 `selfMeta(Ls).kind`，而 `newRegion`（`wow-mock.js:239`）写入的 kind 是 `'frame'/'fontstring'/'texture'/'tooltip'` 等**小写**。真实客户端返回 `"FontString"` 等**首字母大写**。插件 `Tooltip.lua:145` 用 `kind == "FontString"` 判定。
- **影响**：当前不暴露（`GetRegions` 未 mock，该分支走不到），但一旦补 F5 的 `GetRegions`，`ApplyTooltipFont` 的兜底会因大小写失配而**不生效 → 假红**。
- **建议**：`GetObjectType` 映射为真实大小写（frame→"Frame"、fontstring→"FontString"、texture→"Texture"、tooltip→"GameTooltip"）。

### F7【盲区 · P3】`AddLine` 的 no-return 是"全有全无"，比真实客户端更粗

- **证据**：`wow-mock.js:397-405` `AddLine` 只在 `scenario.addLineNoReturn` 时统一 return 0，否则全部返回 FontString。真实客户端 `GameTooltip:AddLine` 多数情况（尤其首行）是**能**拿到左 FontString 的，只是部分行/部分提示框拿不到。
- **影响**：当前插件（`Tooltip.lua:282-299`）**从不使用** AddLine 返回值、一律走 `NumLines()`+全局名扫描，因此这处粗化**不产生假绿**（4b 用例反而是正确钉死了兜底路径）。记录为"已知偏差、当前无害"。
- **建议**：无需改；但若未来有人让插件优先用 AddLine 返回值，需把 no-return 改成"按行号部分返回 nil"以贴近真实。

### F8【假绿 · P2】`Settings`/`MenuUtil` 桩"调了就算过"，`Options:Open` 的真实打开链路无法验证

- **证据**：`wow-mock.js:762-790` `Settings.RegisterAddOnCategory`/`RegisterCanvasLayoutCategory` 等全部 `return stubTable(Ls)`（只建空表、不记录 category→panel 关系、不提供 `category:GetID()` 语义）。测试 `simple-smoke.js:440-441` 只断言 `calls` 里出现了这两个名字字符串。
- **影响（假绿/断言弱）**：即便插件把 `RegisterAddOnCategory` 的返回、`panel.category` 的赋值、`Options:Open` 的 `OpenToCategory` 调用全写错，测试也过。ESC→选项→插件 面板**是否真的能打开**完全没被验证。
- **建议**：至少给 stubTable 生成的 category 挂一个 `GetID()` 返回可断言值，并在测试里触发 `Options:Open()`，断言 `Settings.OpenToCategory` 被以正确 ID 调用（而非只查名字在不在日志里）。

### F9【盲区 · P3】`C_Timer.After` 的 Cancel 不 `luaL_unref`（内存泄漏，不影响断言）

- **证据**：`wow-mock.js:621-637` `After` 的 Cancel 里 `if (timers[tid]) { delete timers[tid]; }` **缺** `luaL_unref`；对比 `NewTimer` 的 Cancel（`wow-mock.js:601-620` 附近）有 `luaL_unref`。
- **影响**：fnRef 永久留在 registry，长时间测试会泄漏。行为断言不受影响。
- **建议**：两处 Cancel 统一补 `luaL_unref`。

### F10【盲区 · P3】`UnitFullName`/`UnitClass`/`UnitFactionGroup`/`UnitExists` 等装置桩与 12.1.0 语义差异未核对

- **证据**：`wow-mock.js:799-815` 全部硬编码返回 `scenario.player` 的固定值；`UnitExists` 恒 true。装置未建模跨服（`UnitFullName` 第二返回值为 realm 但未区分同服/跨服）、`UnitClass` 的第三返回 classID 未接 `C_Unit`。
- **影响**：这些 API 在 12.1.0 已部分迁移到 `C_Unit.*`（`UnitFullName`→`C_Unit.GetFullName` 等），装置仍在用旧全局形态；当前插件只用 `UnitFullName`/`UnitClass`（`Core.lua:96,103`），测试覆盖了基本路径，但"跨服 realm 非空/含空格"等语义差异未建模（见盲区 B6）。
- **建议**：装置按 12.1.0 现状核对 `Unit*` 家族迁移情况；至少把 `UnitFullName` 的 realm 建模成可空/含空格/跨服三种。

---

## 2. 测试盲区（插件有、测试没覆盖的路径）

### B1【P1】ItemRefTooltip（聊天链接）路径：零用例，且 `SetHyperlink` 未 mock

- 插件 `Tooltip.lua:204` 对 `ItemRefTooltip` 做了 `EnsureShowHook`，且 `TooltipDataProcessor` 的 Pre/LinePost/Post 回调对所有 tooltip 通用。但 `simple-smoke.js` **没有任何一条用例**针对 `ItemRefTooltip`。
- 装置虽预置了 `itemRefTooltip` 帧（`wow-mock.js:932`），但无 `SetHyperlink`，聊天链接 → item 数据 → 数量块 的整条链无法驱动。
- **建议**：mock 补 `SetHyperlink(link)`（解析 itemID 并触发 tooltip 流程）；补用例：`SetHyperlink` 一个 item link → 断言 ItemRefTooltip 上出现数量块、字号、下划线锚点正确。**最该补的测试之一。**

### B2【P2】"其他角色打开银行→记录→当前角色悬停显示"端到端链路缺失

- 测试 `simple-smoke.js:152-154` 验证了**当前角色**开银行后 `SL2_DB.chars[key].bank` 被写。但 `Tooltip.lua:17-31` 对当前角色的银行走 `C_Item.GetItemCount` **实时**，**从不读** `SL2_DB.chars[key].bank`。也就是说：§3 断言的那份"银行数据"对当前角色提示框**毫无效果**。
- 真正有意义的链路是"**alt 登录开银行 → alt 的 bank 写库 → main 悬停读到 alt bank**"，而测试里 alt 的 bank 是 `seedAlts`（`simple-smoke.js:105-110`）直接注入的，**绕过了 `Scan:Bank`**。`Scan:Bank` → DB → 提示框 的完整闭环从未被测。
- **建议**：加一条用例：切角色（或直接以 alt 身份 `lifecycle`+`BANKFRAME_OPENED`+`advanceTime`）→ 再以 main 悬停 → 断言 alt 的银行数字来自 Scan 而非预注入。

### B3【P2】语言切换 × 括号对齐 × 字号的组合场景缺失

- 现有用例各自独立：§7/§8 只测 enUS 文本与 `/sl` 切换；§4f 只在 zhCN + 默认字号(12) 下测对齐；§5 只在 zhCN 下测字号。**没有** `/sl en` + 多角色对齐、`fontSize>0` + 多角色对齐、`/sl en` + `fontSize=20` + 对齐 的组合。
- `AlignDetailColumn`（`Tooltip.lua:226-271`）先量前缀再补白，其正确性依赖"`FinalizeBlock` 先定字号 → 再测量"的顺序（E3）；英文 `PAREN_LEFT="     ("`（`Locales.lua:39`）的半角括号 + 5 空格在像素补白下的表现也无人验证。
- **建议**：补组合用例：`/sl en` 且 `fontSize=20` 且 3+ 角色（CJK 名 + 拉丁名），断言英文括号对齐且字号统一。**最该补的测试之一。**

### B4【P2】E1 `pending` 残留反例：装置当前无法构造

- 要构造 E1，需要：先触发 Item preCall（写入 `p.itemID`+`p.lineCount`）→ **中断**（不走 linePostCall 插入、不走 postCall 兜底）→ 再触发**单位**提示框的 linePostCall，令其 `lineIndex == p.lineCount` 巧合命中 → 断言不插入数量块。
- 但装置 `invokeItemTooltipFlow`（1106-1146）是**一气呵成**跑完整流程，且 `linePostCall`/`tooltipPreCall` 只暴露在内部、无公共触发接口（公开 API 只有 `invokeTooltipPostCall`/`invokeItemTooltipFlow`，`wow-mock.js:1172`）。故 E1 当前**不可测**。
- **建议**：公开 `invokeTooltipPreCall(type, frame, data)` 与 `invokeLinePostCall(lineType, frame, lineData)` 两个粒度接口；然后写 E1 反例用例。

### B5【P2】首次登录 `SL2_DB == nil`：`load()` 恒注入 `{}`，nil 防护分支不可测

- `simple-smoke.js:52` `mock.setGlobal('SL2_DB', (scenario.savedVars) || {})`——`savedVars` 默认 null → 恒为 `{}`。插件 `Core.lua:84` 的 `if type(SL2_DB) ~= "table" then SL2_DB = {} end` 分支**永远不会被走到**。
- 真实首登（无 SavedVariables 文件）时 `SL2_DB` 是 nil，这条 nil 防护是真实的正确性关键，却没被测。
- **建议**：`load()` 支持 `scenario.savedVars === undefined` 时**不注入** SL2_DB（或在用例里 `mock.setGlobal('SL2_DB', nil)`），补首登用例。

### B6【P3】玩家名含空格 / 服务器名含空格

- `Core.lua:98` `realm:gsub("%s+","")` 是刻意处理（如 "Moon Guard"→"MoonGuard"），但无用例用 `scenario.player.realm = 'Moon Guard'` 验证 key 归一化；也无角色名含空格（`name`）的用例。
- **建议**：补 realm 含空格用例断言 `key` 正确去空格；补角色名含空格的 key 拼装用例。

### B7【P3】SL2_DB 旧版本残留键

- 无任何用例注入一个"脏" `savedVars`（如含旧版 `options.enabled=true` 或 v1 结构残留键）验证 `ADDON_LOADED` 的回填/不清理行为。`simple-smoke.js:132` 的 `enabled === undefined` 是在干净 `{}` 上断言，测不到"旧键残留时是否泄漏"。
- **建议**：注入 `savedVars = { options: { enabled: true, showOthers: false }, chars: {...} }`，断言 options 只补默认、不保留 enabled 且现有值不被覆盖。

### B8【P2】OnShow/OnHide 钩子与非物品提示框隐藏下划线：从未被触发

- 装置 `Show/Hide/SetShown`（`wow-mock.js:349-350`）只改 `shown` 标志，**不派发 `OnShow`/`OnHide` 脚本或 HookScript 钩子**。故 `EnsureShowHook`（`Tooltip.lua:192-201`）里"非物品提示框 OnShow 时隐藏下划线"、"OnHide 隐藏下划线"两条逻辑**完全没被执行过**。加之 `GetItem` 未 mock（F5），`IsItemTooltip` 恒返回 nil（`Tooltip.lua:185`），`if IsItemTooltip(self) == false` 分支永远不成立。
- **建议**：mock 的 `Show()`/`Hide()` 补派发 OnShow/OnHide（含 HookScript）；补 `GetItem`；写用例：物品→单位→再物品，断言下划线在单位提示框被隐藏。

### B9【P3】ProcessInfo 的 append / excludeLines / linePreCall 未建模

- 见 F4。`invokeItemTooltipFlow` 无 `info.append`、无 `excludeLines`、不调 `linePreCall`。插件虽不用 `linePreCall`/`excludeLines`，但 **E2（append 模式）是真实风险**，当前不可测。
- **建议**：`lineSpecs` 支持 `append: true`（行号继续累加、preCall 时 lineCount 记录为 append 前值），补 E2 反例：append 场景下数量块仍插在**最终**最后一行之后，而非 append 前的位置。

### B10【P3】设置面板悬停（OnEnter/OnLeave）实际行为

- `simple-smoke.js:462-463` 只断言控件"**已接管** OnEnter/OnLeave 脚本"，从不**触发**它们。真实悬停行为（`AttachTooltip` 的 `SetOwner`/`SetText`/`Show`、`HoverBackground:Hide()`，`Options.lua:58-73`）无验证，且 `SetOwner` 未 mock（F5）。
- **建议**：mock 补 `SetOwner`；补触发 `OnEnter` 的接口，断言 `GameTooltip:Show()` 被调、HoverBackground 被 Hide。

---

## 3. 断言质量

### A1【P1】`simple-smoke.js:354-364`（4f）是恒真/闭环断言
同 F1。断言与被测实现共用 `measureText`，验证的是自洽性而非真实行为。虽有"反例"（去补白后 spread 变大）做守卫，但守卫只能证明"补白有作用"，不能证明"补白量正确"。

### A2【P2】`simple-smoke.js:440-441`（§6）"调了 API 就算过"
只检查 `calls` 字符串列表里出现 `Settings.RegisterCanvasLayoutCategory` / `RegisterAddOnCategory` 字样，不验证分类是否真的挂到面板、`Options:Open` 是否能打开。同 F8。

### A3【P3】`simple-smoke.js:442`（§6）斜杠命令断言混乱且虚设
`getGlobal('SLASH_STACKLEDGER1') === 'string' || evalLua('return SLASH_STACKLEDGER1') === '/sl'`：第一分支查装置默认值（装置 `wow-mock.js:883-884` 预置的是 `SLASH_STACKLEDGER1='/stackledger'`、`SLASH_SL1='/sl'`，与插件实际 `SLASH_STACKLEDGER1='/sl'`、`SLASH_STACKLEDGER2='/stackledger'`（`Core.lua:125-126`）**不一致**），第二分支才是真值。且 `invokeSlash('STACKLEDGER',...)`（`simple-smoke.js:408`）**硬编码 SlashCmdList key**，绕过了真实客户端的 `SLASH_*` 全局 → `SlashCmdList` 映射，斜杠注册正确性其实没被端到端验证。

### A4【P3】`simple-smoke.js:131`（§2）`Object.keys(db.options).length === 3` 过度指定
把"恰好 3 个配置键"钉死，属实现细节而非行为；未来合法加第 4 项时会无辜挂测试。建议改为"断言 enabled 键不存在 + 断言已知三键存在"，不锁总数。

### A5【P3】`simple-smoke.js:226-227`（§4d）颜色断言依赖实现常量
`r===1 && g<0.3 && b<0.3` 钉死了 `UNDERLINE_R/G/B`（`Tooltip.lua:156`）的取值。作为回归钉合理，但属实现细节而非"红线可见"的行为断言。

---

## 4. 工具链

### T1【P2】`lua-check.js` 用 `luaVersion: 5.1` 解析，而装置 `fengari` 是 Lua 5.3 —— 语法口径与运行时不一致
- `lua-check.js:12` `WOW_LUA = '5.1'`；`wow-mock.js:3` 明写"fengari 纯 JS Lua 5.3 VM"。
- **影响**：语法按 5.1 校验、语义按 5.3 执行。分歧点：整数/浮点子类型（`1.0..""=="1.0"` 是 **5.3 独有**）、`//` 整除、位运算 `&|~<<>>`、`unpack` 全局移除、`goto`。此前踩的 `1.0.."1.0"` 坑正是这一分歧的产物——插件已用 `math.floor(i)`+`string.format("%d")`（`Tooltip.lua:131-132`）防御，但**防御只在 5.3 mock 下被验证**，而真实客户端（项目自己声明 5.1）下 `1.0..""` 其实是 `"1"`（无 `.0`），二者行为相反。
- **建议**：把 `luaparse` 的 `luaVersion` 改成 `'5.3'` 以与**实际执行器 fengari 对齐**；并在文档里明确"mock 是 5.3、客户端是 5.1"这一根本差异（若客户端其实不是 5.1，需要先核实，这直接影响 mock 的保真度）。

### T2【P3】`api-audit.js` 规则覆盖与当前代码的真实风险
- **覆盖良好**：`GetItemCount`/`GetContainerItemInfo`/`GetContainerNumSlots`/`GetContainerItemLink` 弃用、裸负数 ID、hyperlink 解析、`C_Timer.After 0.5` 盲等、`GetItemInfo` nil 容错（`api-audit.js:13-30`）。`GetItemCount` 规则用 `(?<![\w.:])` 负向后行断言正确放过了 `C_Item.GetItemCount`。
- **缺口**：
  1. **`GetItem`/`SetItem` 未列入规则**——但当前插件调用的是 `tooltip:GetItem()`（`Tooltip.lua:185`，是 GameTooltip **方法**，非弃用全局），故**无假阳性、也无需规则**；真正要防的是未来误用**全局** `GetItemInfo`（12.x 已弃用，应走 `C_Item.GetItemInfo`），api-audit 目前对 `GetItemInfo` 只有 WARN 且不区分全局/`C_Item` 前缀。
  2. 未覆盖 `UnitFullName`/`UnitClass`/`GetInventoryItemID` 等 `Unit*`/`GetInventory*` 家族的 12.x 迁移（当前插件用 `UnitFullName`/`UnitClass`，见 F10）。
  3. 未覆盖 `C_Item.GetItemCount` 5 参签名正确性（E5，regex 无法判）。
- **建议**：为"全局 `GetItemInfo`（非 `C_Item.` 前缀）"加 ERROR 规则；给 `UnitFullName`/`UnitClass` 加 WARN 提示核对 12.x 是否仍可用。

---

## 5. 装置已知偏差及影响评估（总表）

| # | 偏差 | 位置 | 影响 | 优先级 |
|---|---|---|---|---|
| F1 | measureText 0.25/0.5em 均匀度量，无比例字宽 | wow-mock.js:42-49,429 | **假绿**（4f 对齐闭环恒真） | P1 |
| F2 | GetItemCount 内建 5 参语义 | wow-mock.js:695-706 | **假绿**（E5 不可证伪） | P2 |
| F3 | lineData 非同一对象，`==p.lastLine` 分支不触发 | wow-mock.js:1112-1140 | **假绿/盲区** | P2 |
| F4 | 行号 1:1 干净计数 + 无 append/excludeLines/linePreCall | wow-mock.js:396,1106-1146 | **假绿**（E1/E2 不可测） | P2 |
| F5 | 缺 SetOwner/GetItem/GetRegions/SetHyperlink | buildRegionMethods(277-501) | 假红·潜在 + 盲区 | P3 |
| F6 | GetObjectType 返回小写 kind | wow-mock.js:493 | 假红·潜在 | P3 |
| F7 | AddLine no-return 全有全无 | wow-mock.js:397-405 | 盲区（当前无害） | P3 |
| F8 | Settings/MenuUtil 桩"调了就算过" | wow-mock.js:762-790 | **假绿/断言弱** | P2 |
| F9 | C_Timer.After Cancel 不 unref | wow-mock.js:621-637 | 内存泄漏 | P3 |
| F10 | Unit* 家族桩未核对 12.1.0 迁移 | wow-mock.js:799-815 | 盲区 | P3 |

## 6. 已核对无问题清单

1. **同名方法重复定义**：当前文件已**无**重复定义（已 grep 全部 region 方法名核对）。历史 D6 的 `GetStringWidth` 重复覆盖缺陷已修复，且重复定义在审计窗口内被清理（见第 0 节，建议确认改动归属）。
2. **`GetStringWidth` 返回 0 的桩**：已不存在，现返回 `measureText`（wow-mock.js:429-434）。
3. **`stubTable` 引用不存在的 Ls**：已修复，`stubTable(state)` 接收并正确使用传入的 Lua state（wow-mock.js:762）。
4. **`logApi` 转换 frame 表抛错导致 pcall 假失败**：已修复，`safeArg` 用 try/catch 兜底返回 `<unconvertible>`（wow-mock.js:216-218），`logApi`/`logRegion` 均走 `safeArg`（227/220）。
5. **`seedAlts` 用 Lua 侧注入保证 itemID 数字键**（simple-smoke.js:105-110）：正确规避了 JS→Lua 字符串键陷阱。
6. **§3 `getGlobal` 快照需重取**（simple-smoke.js:142 注释）：已正确注意。
7. **§4b AddLine 无返回兜底路径**：正确钉死了按行号扫描的兜底（simple-smoke.js:201-213）。
8. **§7b 两套词条键集合一致**（simple-smoke.js:388-401）：覆盖了 A14 词条完整性。
9. **`1.0.."1.0"` 坑**：插件已用 `math.floor`+`%d` 防御（Tooltip.lua:131-132），且装置 NumLines 用 `pushinteger`，当前无该坑复发。

---

## 7. 最该补的 3 个测试（按价值排序）

1. **E1 pending 残留反例**（B4+F3+F4）：给装置公开 `invokeTooltipPreCall`/`invokeLinePostCall` 粒度接口，构造"物品 preCall → 中断 → 单位提示框 lineIndex 撞 lineCount → 断言不插入数量块"。直接钉死最危险的状态残留 bug。
2. **ItemRefTooltip 聊天链接端到端**（B1+F5）：mock 补 `SetHyperlink`，断言聊天链接 item 的数量块/字号/下划线在 ItemRefTooltip 上正确。
3. **比例字体对齐 + 组合场景**（F1+B3）：把 `measureText` 换成真实字宽表（CJK 全角），并加 `/sl en + fontSize>0 + 多角色（CJK+拉丁名）` 的对齐断言，打破 4f 的闭环恒真。

---

*报告完。以上"假绿风险"4 条（F1/F2/F3/F4）、"测试盲区"10 条（B1-B10）、断言质量 5 条（A1-A5）、工具链 2 条（T1/T2）、装置偏差表 10 条（F1-F10）。*
