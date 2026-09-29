# A — 代码正确性与运行时风险（对抗审计）

> 审计员 A（独立对抗视角，假设作者过于乐观）。被审对象：`D:\Game\World of Warcraft\_retail_\Interface\AddOns\StackLedger\`（v0.7.0，5 Lua / 785 行）。
> 结论分级：P0 数据错误/报错/污染 · P1 明显缺陷/兼容风险 · P2 健壮性 · P3 风格；每条标注 **确证** 或 **需实测**。
> API 事实核对基于 `Gethe/wow-ui-source` live 分支源码（`Blizzard_APIDocumentationGenerated` 下各 `*Documentation.lua`）。

---

## 零、E1–E6 逐条结论（先给结论，细节见后文对应条目）

| # | Lead 疑点 | 结论 |
|---|---|---|
| E1 | pending 残留让单位提示框误插数量块 | **证伪为高概率 bug，但确证为结构性脆弱**（P2）。原因：`OnItemTooltip` 兜底 post-call 对每次 Item 提示框都把 `inserted=true`，正常流程后残留无害；误插需“物品流程中断 + 行数巧合 + inserted 仍为 false”三者同时成立，概率低。但 `pending` 不在 OnShow/OnHide 重置、`OnAnyLine` 注册在全部行类型上，是货真价实的脆弱点，建议加防御（详见 §1）。 |
| E2 | append 模式 `lineIndex==lineCount` 误判 | **需实测**（P2）。`IsLastNativeLine` 有双重判据：`lineData==p.lastLine`（表引用）优先，`lineIndex==p.lineCount` 兜底。append（对比框）下若 `lineIndex` 是“绝对行号”，兜底判据会失效，只剩表引用判据；两者都失效时退化为 post-call 末尾插入（功能降级，不崩溃）。参考判据可靠性取决于客户端是否把 `data.lines[i]` 的**同一张表**传给 `AddLinePostCall`，无法仅凭文档证实（见 §2）。 |
| E3 | 先定字号后测量 | **证伪（顺序正确）**。`InsertBlock` = 加行 → `FinalizeBlock`（ApplyTooltipFont 全局字号）→ `AlignDetailColumn`（读各行最终字体再量宽度）。字号=0 与 >0 两条路径下测量字体都是“最终字体”；ItemRefTooltip 走同一 TooltipDataHandler 管线。仅一处副作用（见 §3）。 |
| E4 | 材料银行漏记 / BankBag(-4) | **需实测，但倾向“大概率无缺陷”**。已核实 `FetchPurchasedBankTabIDs(Character)` 返回 `InnerType=BagIndex`（可直接当容器 ID 用，Scan.lua 用法正确）。但检索到 “Reagent Bank 与 Void Storage 已在 11.2 银行改版中移除”，12.1.0 若属实则**材料银行已不存在**，`Scan.lua` 不扫它是对的；`BankBag(-4)` 大概率是遗留空容器（返回 0 槽，无害）。若 12.1.0 仍保留材料银行，则是 P1 漏记（见 §4）。 |
| E5 | `GetItemCount` 第 5 参 `includeAccountBank` | **确证存在**。live `ItemDocumentation.lua`：`GetItemCount(itemInfo, includeBank, includeUses, includeReagentBank, includeAccountBank)`，第 5 参 `includeAccountBank` 为 `bool, Default=false`。`bank=all-bags` 的减法正确（见 §5）。 |
| E6 | 语言切换不 Fire CONFIG_CHANGED，缓存需否失效 | **证伪（无需失效）**。`cache` 只存 `{name,class,bags,bank,total,isPlayer}`（纯数字+名字），语言相关词条（`SL.L.BAGS/BANK/PAREN_*`）在 `RowText` 渲染时实时解析，缓存里无语言内容（见 §7）。 |

---

## 1. 回调生命周期与残留状态（E1）

**文件**：`Tooltip.lua:213`、`330-336`、`192-201`、`339-352`

```lua
local pending = setmetatable({}, { __mode = "k" })   -- tooltip → { itemID, lineCount, lastLine, inserted }
...
local function OnAnyLine(tooltip, lineData)
    local p = pending[tooltip]
    if not p or p.inserted or not p.itemID then return end
    if not IsLastNativeLine(tooltip, lineData) then return end
    p.inserted = true
    InsertBlock(tooltip, p.itemID)
end
```

**为什么需要关注（结构事实，确证）**：
1. `pending` 以 tooltip 帧为键，只在 Item 型 `AddTooltipPreCall`（`357-369`）里重置 `inserted=false / itemID`。OnShow/OnHide 钩子（`192-201`）**不清理 pending**。
2. `OnAnyLine` 注册在 `Enum.TooltipDataLineType` **全部**行类型上（`373-379`），单位/法术提示框的行回调也会触发 `OnAnyLine`。
3. 兜底 `OnItemTooltip`（`AddTooltipPostCall(Item,…)`，`382-384`）对每次 Item 提示框执行：只要 `data.id` 真值，就会 `p.inserted = true`（`346-348`）。

**误插反例是否成立（需实测，但倾向低概率）**：误插需同时满足
(a) 某次物品流程**中断**（既没在行回调插入、也没走到 post-call 兜底）→ `inserted` 保持 false；
(b) `itemID` 仍真值；
(c) 下一帧的单位提示框原生行数恰好 == 残留的 `p.lineCount`；
(d) 单位最后一行 `lineData.lineIndex == p.lineCount`。
由于 (a) 与 post-call 兜底互斥——正常物品流程 post-call 必把 `inserted=true`——(a) 只在**流程被打断**（如 `TooltipDataProcessor` 异常提前返回、对比框/异步重建等非常规路径）时发生。故“单位框误插数量块”为**低概率**，非必然。

**但仍建议修（P2，防御性，改 `Tooltip.lua` 的 `EnsureShowHook`）**：
```lua
tooltip:HookScript("OnShow", function(self)
    ApplyTooltipFont(self)
    if IsItemTooltip(self) == false then HideUnderline(self) end
end)
```
在 OnShow 里加一句 `pending[self] = nil`（或至少 `if pending[self] then pending[self].inserted = true end`），让“非 Item 提示框一旦显示就作废旧 pending”，可一次性消除整个跨类型污染类，成本近零。

**`IsLastNativeLine` 两个判据各自安全性**（`314-320`）：
- **表引用判据** `lineData == p.lastLine`（`317`）：依赖“`AddLinePostCall` 传入的 `lineData` 就是 `data.lines[#]` 的同一张表”这一客户端行为。注释已声明是客户端行为，但**无法从文档证实**（需实测）。若客户端传的是副本/重构对象，此判据恒假。
- **lineIndex 判据** `index == p.lineCount`（`319`）：依赖 `lineData.lineIndex` 是“在该 `data.lines` 内的 1-based 序号”。若 `lineIndex` 是绝对行号（append 下会累加）或某些行类型不含 `lineIndex`，此判据不可靠（见 E2）。
- 两个判据**互为兜底**，单一失效不会崩，最坏退化为 post-call 末尾插入（功能降级、位置后移），不产生错误数据。

---

## 2. append 模式（E2）

**文件**：`Tooltip.lua:314-320`

`info.append`（`TooltipDataHandlerMixin:ProcessInfo`）下 `ClearLines` 不调用、行号累加。此时：
- 若 `lineData.lineIndex` 是**绝对行号**（含前一段的累计），则 `lineIndex == p.lineCount`（`p.lineCount=#lines` 是**本次**追加段的行数）**不相等** → 兜底判据失效；
- 只剩 `lineData == p.lastLine` 表引用判据（`317`）能命中，前提是客户端传同一张表；
- 两者都失效 → `OnAnyLine` 不插入 → 落到 `OnItemTooltip` 末尾插入（`348`），**功能不丢、不崩溃**，只是块位置跑到提示框末尾。

**结论**：P2，**需实测**（在对比框/Shift 对比下确认块插入位置）。修复方向：`OnAnyLine` 里对 `lineIndex` 判据不做“绝对值等于 lineCount”的强假设，改为“`lineIndex >= p.lineCount`”或只依赖表引用 + 兜底；或在 pre-call 记录 `#lines` 时同时记录 `lines[#lines]` 的 `lineIndex` 作为锚点。`AlignDetailColumn` 的行号定位（`241`、`308`）用的是 `tooltip:NumLines()` 现取行号 + 立即 `AddLine` 后回读，**不依赖原生 lineCount**，append 下依然正确（见 §3/§7 已排查项）。

---

## 3. 执行顺序（E3）

**文件**：`Tooltip.lua:323-328`（InsertBlock）→ `303-311`（FinalizeBlock）→ `226-271`（AlignDetailColumn）

顺序为：`AddCountBlock` 加行 → `FinalizeBlock`（`ApplyTooltipFont` 应用全局字号）→ `AlignDetailColumn`（对每个 `_G[<name>TextLeft<i>]` 读 `GetFont` 得到 `path,size,flags`，再 set 到隐藏测量 FontString 后 `GetStringWidth`）。

**顺序正确（确证）**：
- 字号=0：`ConfiguredSize()` 返回 nil，`ApplyTooltipFont` 早退 → 各行保持游戏/其他插件设置的字体；`AlignDetailColumn` 读到的就是“最终字体”。✓
- 字号>0：`ApplyTooltipFont` 先对 `TextLeftN/TextRightN` `SetFont`，`AlignDetailColumn` 随后读同一 FontString 的 `GetFont` → 也是“最终字体”。✓
- ItemRefTooltip：`EnsureShowHook(ItemRefTooltip)`（`204`）挂 OnShow 字号；ItemRef 的物品链接走同一 `TooltipDataHandler` 管线（SetHyperlink→Item data），pre/post call 均触发，`InsertBlock` 同样“先定字号后测量”。✓

**唯一副作用（P2，需实测视觉）**：`ApplyTooltipFont`（`115-118`、`120-152`）用 `GameFontNormal` 的 **path** 强写所有行，并把 flags 硬编码为 `""`：
```lua
local path = GameFontPath()                              -- GameFontNormal 的字体文件
ApplyFont(fontString, size, path)                        -- SetFont(path, size, "")
```
这满足“全局字号”，但同时**强制了字体族**（所有行变 `GameFontNormal` 的文件）并**抹掉** `MONOCHROME`/`THICKOUTLINE` 等 flags。A4 只要求“字号”全局、默认“一无所改”。若用户/皮肤插件（EllesmereUI、字体替换）把 `GameTooltipText`/`GameTooltipHeaderText` 覆盖成与 `GameFontNormal` 不同的字体文件，字号>0 时会把这些行拉回 `GameFontNormal` 字体族，偏离“只调字号”。**修法**：`ApplyFont` 改为先 `GetFont` 取该行自身 `path/flags`，再 `SetFont(自身path, size, 自身flags)`，只改 size。

---

## 4. Scan.lua 数据正确性（E4）

**文件**：`Scan.lua:44-57`（BankIDs）、`18-29`（AddContainer）、`67-77`（Save）

**已核实正确（确证）**：
- `C_Bank.FetchPurchasedBankTabIDs(Enum.BankType.Character)` 返回 `InnerType = BagIndex`（live `BankDocumentation.lua`）→ 返回的就是**可直接用于 `GetContainerNumSlots/GetContainerItemInfo` 的容器 ID**，`Scan.lua` 直接把 `list[i]` 当容器 ID 用**正确**，无需 `BankButtonIDToInvSlotID` 换算。
- 背包 `BagIDs()` = `Backpack(0)..Bag_4(4)` + `ReagentBag(5)`，即“0..5”，与需求“背包 0..5”一致；`ReagentBag=5` 若已废弃，`NumSlots(5)` 返回 0 → 无害。

**材料银行是否漏记（需实测，倾向无缺陷）**：
- 检索到官方论坛信号 “Reagent Bank 与 Void Storage 在 11.2 银行改版中被移除”（[eu.forums.blizzard.com 帖](https://eu.forums.blizzard.com/en/wow/t/reagent-bank-and-void-storage-removed-in-patch-112s-bank-update/580397)，本机直连被拦，仅标题可见）。若 12.1.0 属实，**材料银行已不存在**，`Scan.lua` 不扫它正确，`CurrentCounts` 里 `includeReagentBank=true`（`Tooltip.lua:25`）退化为无害的恒 0 参数，`Scan.lua:43` 注释“不区分材料区”成为过期文案。
- 若 12.1.0 仍保留材料银行（`BankType.Reagent` 独立容器），则 `BankIDs()` **漏掉它** → 其他角色“银”少算材料银行，与当前角色“银”（`includeReagentBank=true` 已含）不一致。这是唯一的分支风险，**需在 12.1.0 实测**：开银行看材料银行页是否还存在；若存在，`BankIDs()` 需补 `Enum.BagIndex.Reagentbank`（-3）。
- **战团银行（账户银行）不扫是对的**：账户银行是账号级共享存储，不随角色变；当前角色经 `includeAccountBank=true` 已计入“银”，若再按角色扫描会重复（且无法归属单一角色）。

**`slots==0` 防误清空策略在“部分容器可读”时的行为（P2，确证逻辑 / 需实测触发）**：
```lua
local function Save(source, counts, slots)
    if slots == 0 then return end               -- 容器未加载 → 保留上轮数据，不写空表
    ...
    rec[source] = counts
```
`Collect` 的 `slots = Σ AddContainer(ids[i])`，`AddContainer` 对未加载容器返回 0。判据是**总槽数==0** 才跳过。当**部分容器可读**（如银行某 tab 加载了、另一 tab 尚未加载）时 `slots>0`，会**写入只含已读容器的不完整 counts**，把未读容器的旧数据抹掉。触发条件：`BANKFRAME_OPENED` 后 0.5s debounce 内某 tab 数据未就绪（慢加载/网络）。**修法**：`Save` 改成“按容器分别校验”，或把“跳过写”的条件改为“可读容器数 < 期望容器数”（如 bank 期望 `#ids` 个都非 0），而不是“总和==0”。

---

## 5. API 事实核对（全部基于 live 源码）

1. **`C_Item.GetItemCount` 第 5 参（E5）— 确证存在**。live `ItemDocumentation.lua`：
   ```
   GetItemCount(itemInfo, includeBank=false, includeUses=false, includeReagentBank=false, includeAccountBank=false) → count
   ```
   注释 `-- includeBank=true, includeUses=false, includeReagentBank=true, includeAccountBank=true` 与实参 `getCount(itemID, true, false, true, true)` 一致。`all = bags+银行+材料银行+战团`，`bags = GetItemCount(itemID)`（基础恒含背包），故 `bank = all - bags` **正确隔离出银行+材料+战团**，无重复、无漏（确证）。
2. **`GetContainerItemInfo` 返回字段 — 确证**。返回 `ContainerItemInfo`：`iconFileID, stackCount, isLocked, quality, isReadable, hasLoot, hyperlink, isFiltered, hasNoValue, itemID, isBound, itemName`；且函数 `MayReturnNothing=true`（空槽返回 nil）。`Scan.lua:23-26` 用 `info.itemID`、`info.stackCount` **字段名正确**，`if info and info.itemID` 守卫覆盖空槽。
3. **`UnitFullName` 的 realm — 确证恒非空**。live `UnitDocumentation.lua`：`UnitFullName(unit) → unitName(cstring,Nilable=false), unitServer(cstring,Nilable=false)`。`Core.lua:98` 的 `(realm or ""):gsub(...)` 是纯防御，实际不会为 nil。`key = realm.."-"..name` 稳定唯一（realm 去空格仅影响含空格服务器名，无同名冲突风险）。

---

## 6. taint / 战斗安全

**无原生方法替换（确证）**：全代码仅用 `tooltip:HookScript`（`195-200`）、`TooltipDataProcessor.AddTooltipPreCall/AddLinePostCall/AddTooltipPostCall`（`354-384`），以及**自己创建**的 options 控件上的 `SetScript`（`Options.lua:64-72`）。无一处 `hooksecurefunc` 以外的方法覆盖，战斗安全无污染源。
**`tooltip.__slXxx` 字段写 GameTooltip（确证安全）**：给保护帧**新增**表字段、`CreateTexture` 挂到 tooltip 是标准且安全的操作，不 taint、不影响战斗保护路径。
**OnShow/OnHide 钩子不重复累积（确证）**：`EnsureShowHook` 以 `tooltip.__slHooked` 守卫（`193`），且仅在文件加载时对 `GameTooltip`/`ItemRefTooltip` 各调用一次（`203-204`），无重复注册。
**`IsItemTooltip` 调 `GetItem`（安全）**：只读，不污染。

---

## 7. 性能与内存

- **每次悬停开销（P3）**：默认 `fontSize=0` 时 `ApplyTooltipFont` 早退，悬停几乎零开销。`fontSize>0` 时每次 OnShow 遍历 `NumLines` 逐行 `SetFont` + `GetRegions` 全量扫描（`120-152`），含 `string.format("%sTextLeft%d")` 临时字符串垃圾。可接受，可优化为只在字号变更时重刷。
- **`__slMeasure`/`__slUnderline` 不泄漏（确证安全）**：均在 `if not tooltip.__slXxx` 下惰性创建并缓存到帧上，每提示框（共 2 个帧）仅一份，随帧存续，不逐次新建。
- **`cache` 失效路径（P3）**：`cache` 键为 itemID、值为 rows，仅在 `DATA_CHANGED`/`CONFIG_CHANGED` 清空（`387-388`），无容量上限，长会话悬停大量不同物品会缓慢增长（每条目一个小表）。可加简单上限或 LRU，非必需。
- **E6 语言与缓存（确证无需失效）**：`BuildRows` 产出的 row 只含 `name/class/bags/bank/total/isPlayer`（数字+名字），不含任何 `SL.L` 词条；`SL.L.*` 在 `RowText`（`80-95`）渲染时经代理实时解析。`/sl en` 改 `options.locale` 不经 `SL:Set`（`Options.lua:170-184`）故不 Fire CONFIG_CHANGED，但因为缓存无语言内容，**不需要失效**，提示框即时变语言（因为下一次悬停重新走 `RowText`）。

---

## 8. SavedVariables

- **数字键 reload 后类型（确证：number 保留）**：WoW 保存时整数键写成 `[190320] = 5`（无引号），reload 解析回 number 键。`Scan.lua:25` `counts[info.itemID]`（itemID 为整数）与 `Tooltip.lua:49-50` `rec.bags[itemID]`（number）**键类型一致**，读取不丢数据。⚠️ 注意：现有测试 `tools/tests/db-structure.js:34` 用 `bags['123']`（字符串键）断言——那是 JS mock 对象把数字键强转字符串的**假象**，不是真实客户端行为，勿据此反推。
- **name/class 冗余（P3）**：`rec.name`/`rec.class` 用于显示（无法从其他角色离线取 class），必要；仅 `key` 已含 name 属轻微重复。可接受。
- **删除角色后残留 + 同名复用污染（P2，确证逻辑）**：简化版无任何清理。`SL2_DB.chars[key]` 永久保留。删除角色后：① 幽灵角色继续以“其他角色”出现在提示框（`BuildRows` 遍历全部 chars，`Tooltip.lua:47-58`）；② 更糟——**同名同服新建角色会继承旧角色的 `bank`**：登录时 `Scan:Bags()` 会覆盖 `bags`，但 `bank` 要等新角色开银行才覆盖，期间显示的是已删旧角色的银行数据。**修法**：`ADDON_LOADED` 或 `PLAYER_ENTERING_WORLD` 时用 `GetNumCharacters()/GetCharacterInfo()` 枚举现存角色，删除不在名单里的 `chars[key]`（可标注为“未覆盖/可选增强”）。

---

## 9. 已排查且无问题（确认安全）

| 项 | 查了什么 | 为何安全 |
|---|---|---|
| E5 战团并入“银” | `GetItemCount` 签名与减法 | 第 5 参存在且语义匹配；`all-bags` 正确（GetItemCount 基础恒含背包） |
| GetContainerItemInfo 字段 | live 结构体 | `itemID`/`stackCount` 正确，空槽 nil 有守卫 |
| UnitFullName realm | live 文档 `Nilable=false` | 恒非空，`realm or ""` 仅防御 |
| E3 测量顺序 | InsertBlock/FinalizeBlock/AlignDetailColumn 调用链 | 先定字号后测量，0/>0 两路径皆“最终字体” |
| 对齐测量不带颜色码 | `PlainPrefix`（`76-78`）用无码名 | 颜色码 `\|c..\|r` 零宽，测量与着色等宽 |
| E6 缓存语言无关 | `BuildRows`/`RowText` 职责 | 缓存只存数字+名字，词条实时解析，无需失效 |
| 无原生方法替换 | 全量 grep hooksecurefunc/方法覆盖 | 仅 HookScript + TooltipDataProcessor + 自建控件 SetScript |
| OnShow/OnHide 不累积 | `__slHooked` 守卫 + 仅调用两次 | 不重复注册 |
| `__slMeasure/Underline` 不泄漏 | 惰性创建 + 帧缓存 | 每帧一份，不逐次新建 |
| `AlignDetailColumn` 行号定位 | 用 `tooltip:NumLines()` 现取 + `AddLine` 后回读 | 不依赖原生 lineCount，append 下依然正确 |
| `IsItemTooltip` 返回 nil/false 语义 | `184-189` | GameTooltip/ItemRefTooltip 均有 `GetItem`，单位框必走 `==false` 隐藏下划线；OnHide 再兜底隐藏 |
| 其他角色排序确定性 | `BuildRows` 末尾 `table.sort` | `pairs` 无序但排序后 isPlayer→total 降序→name 稳定 |

---

## 10. 附：测试套件与实现版本错位（供 Lead，非代码缺陷）

`tools/tests/*.js` 仍针对 **v1.x 架构**（`SL_DB`、`StackLedger.Data:SetCounts/SetWarband`、`db.warband`、`db.global.items`、`rec.equip/reagent`、模板渲染 `StackLedger.Util.Format`），而当前被审对象是 **v0.7.0 简化版**（`SL2_DB.chars[key].bags/bank`，无 warband/global/equip/模板）。即“三道关卡”里的 `simple-smoke.js` 当前**并未覆盖 v0.7.0 的真实代码路径**，回归保护可能形同虚设。此为质量门（需求 §B）层面的风险，建议 Lead 单独跟进。

---

## 11. 修复优先级（“只能修 3 处”的建议）

1. **E1 防御（Tooltip.lua `EnsureShowHook`）**：OnShow 里 `pending[self] = nil`。成本一行，根除跨类型污染类。
2. **Scan.lua 部分可读误清（`Save`）**：把“跳过写”从 `slots==0` 改为“可读容器数 < 期望容器数”，防部分加载时误清银行/背包旧数据。
3. **Tooltip.lua `ApplyTooltipFont` 保留字体族与 flags**：只改 size、保留各行自身 `GetFont` 的 path/flags，避免字号>0 时拉平其他插件/皮肤的提示框字体（兼容 EllesmereUI 等）。

（备选第 4 处：删除角色/同名复用残留清理，见 §8——重要性高但实现量更大，可放到下一版。）
