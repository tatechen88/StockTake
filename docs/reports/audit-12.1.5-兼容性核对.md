# StockTake 12.1.5 兼容性核对（任务票 StockTake-001）

> 执行日期：2026-10-16｜执行者：DSH 执行器
> 本机客户端：`D:\Game\World of Warcraft`（分支 `cn`，`Version!STRING = 12.1.5.70391`）
> 本报告**不覆盖**任何既有审计报告；历史证据（`docs/reports/*`、`docs/reports/audit-v097/*`）原样保留。

---

## 0. 结论摘要

任务票的核心前提（"运行副本里有未纳入仓库的品质材料多 itemID 合并逻辑，需审查后纳入"）**与仓库实际状态不符**，
在核对第一项即命中任务票自身的停止条件，因此本次**未改动任何插件源码、未同步运行副本、未触碰 Git**。

| 事实 | 证据 |
|---|---|
| 本地 `HEAD` = `44c2014a3a7ef19a6369801488d876f4af2e3230`（`## Version: 0.9.7`） | `git rev-parse HEAD` |
| `origin/main` = `ea5fb2593268fdd4ee0e4fbb4f65f8092ded99c5`（`## Version: 1.0`） | `git ls-remote origin refs/heads/main` |
| 二者是**快进关系**，本地落后 **10 个提交**（`0 10`） | `git rev-list --left-right --count HEAD...origin/main`；`git merge-base --is-ancestor HEAD origin/main` → 0 |
| 运行副本 13 个文件与 `origin/main` **git blob 哈希逐一相同** | 见 §4 |
| 品质材料逻辑**已在上游提交**，不是运行副本的未纳管改动 | `ea5fb25 [发布] StockTake 1.0 首个正式版：同名多品质材料合并计数 + 每角色品质明细` |
| 12.1.5 的 `.toc` Interface 号 `120105` **未被声明** | 见 §6 |

---

## 1. 基线快照（任务票验收第 1 项）

### 1.1 仓库

```
$ git rev-parse HEAD
44c2014a3a7ef19a6369801488d876f4af2e3230

$ git ls-remote origin refs/heads/main
ea5fb2593268fdd4ee0e4fbb4f65f8092ded99c5  refs/heads/main

$ git status --short
 D Media/StockTake-Icon.tga        # 未提交的删除状态，本次未触碰，保持原样

$ git rev-list --left-right --count HEAD...origin/main
0  10
```

### 1.2 运行副本文件清单与逐文件 SHA256

路径：`D:\Game\World of Warcraft\_retail_\Interface\AddOns\StockTake`

| 文件 | SHA256 |
|---|---|
| `CHANGELOG.en.md` | `304FAFA51E3B52684B469364D621712775A408DD1ADEFC735B737F40E9E03218` |
| `CHANGELOG.md` | `7DC1DFC38249877537573FC7913B22A7E8A97A7022B6C97212FF3F0914F92AB4` |
| `Core.lua` | `C645C876C4539DEE54EE2E23D57B1AA0EE87A1FFDDA303835D10CDB3FBC43266` |
| `LICENSE.txt` | `40E61A1E093AB6FD429E32368613702D77F9BD539D54F823455020F4533DCD3E` |
| `Locales.lua` | `16DBF11969DB8B377720E62031566432A52D01B0A2EAF595100D37388951BBCE` |
| `Options.lua` | `964AD055511FFEB7C40FB0699726B4BDAFBC1CD60699620B99B38AC451BF9189` |
| `README.en.md` | `27332822D445F1519EBC2DF2790E4B9A3FE46FDF7012ED95E5462CBE0567F8F1` |
| `README.md` | `AA0A9A556D07E68C7841EBA0232807617F31D1A3EF48D94E97E7DDA93C864458` |
| `Scan.lua` | `862AEA8024ABD1D0111EDE65E208E334584A4442017D92EF1700E5FD50A0B4D0` |
| `StockTake.toc` | `AACA337D0BF16C425D6092F1550EFF6D905148BA008BA97A2500BA856486F9AF` |
| `Tooltip.lua` | `9467794EC774AFFEB3E1DD83177697A564902B47884E11F01F136C8F9974BF39` |
| `Media\StockTake-Icon.tga` | `68C102A1B82F56B6BAAAAE1C8B6A85DBCF873CAF8893619DEF0578ACA392F30B` |

同步状态：**本次未同步**（见 §5）。上表即"同步前哈希"，同步后哈希与之相同（无同步动作）。

---

## 2. 关卡原始结果

### 2.1 本地工作区（`HEAD` = 0.9.7）

| 命令 | 原始结果 | 退出码 |
|---|---|---|
| `npm --prefix tools install` | `up to date, audited 6 packages in 4s` / `2 moderate severity vulnerabilities` | 0 |
| `node tools/lua-check.js .` | `语法校验: 5 通过 / 0 失败 / 0 缺失（共 5 个 .lua）` | 0 |
| `node tools/api-audit.js .` | `API 审计: 5 个文件, 0 个 ERROR, 0 个 WARN` | 0 |
| `node tools/simple-smoke.js` | `汇总：228 用例，228 通过，0 失败` | 0 |
| `node tools/check-zhtw.js README.zhTW.md CHANGELOG.zhTW.md Locales.lua StockTake.toc` | **FAIL `StockTake.toc`（全文，12 处简体字）**；`OK README.zhTW.md` / `OK CHANGELOG.zhTW.md` / `OK Locales.lua (local zhTW 区块)`；`合计命中：12` | **1** |

**该 FAIL 是任务票命令写法导致的必然假阳性，不是文案缺陷**：

- `tools/check-zhtw.js` 只对 **Lua 文件**识别 `local zhTW = {` 区块并按区块检查（脚本 L148–L158）；
  对非 Lua 文件一律按「**全文**」检查。
- 传入 `StockTake.toc` 时脚本对全文扫描，于是 `## Title-zhCN:` / `## Notes-zhCN:` 这两行**本就该是简体**的
  zhCN 文案、以及第 16 行中文注释，被当成"繁体里的简体字"报出（12 处全部来自这三处）。
- 无参数调用 `node tools/check-zhtw.js` 直接 `usage: node tools/check-zhtw.js <file...>`（退出码 2）。

### 2.2 上游内容（`origin/main` = 1.0，= 运行副本）

为避免在过期工作区上做判断，把 `origin/main` 解出到 `.scratch/origin-main-verify/`（git 忽略目录）后跑同一套关卡：

| 命令 | 原始结果 | 退出码 |
|---|---|---|
| `python _apidoc\check_project_api.py Core.lua Scan.lua Tooltip.lua Options.lua Locales.lua` | `已核对 API 引用点: 10` / `发现问题: 0` | 0 |
| `node tools/simple-smoke.js` | `汇总：261 用例，261 通过，0 失败` | 0 |

（同上脚本对本地 0.9.7 源码：`已核对 API 引用点: 3` / `发现问题: 0`。）

> ⚠️ `check_project_api.py` 只识别 `C_Xxx.Member` 点调用与 `CallDot(_G.C_Xxx, "Member")`，
> **不检查** `Enum.*` 成员、全局函数、事件名、结构体字段。因此"0 问题"不能替代 §3 的逐项人工对表。

---

## 3. 12.1.5 API 对表

### 3.1 镜像缺口（任务票已预判的阻塞项）

| 项 | 值 |
|---|---|
| 本机客户端 | **12.1.5.70391**（`D:\Game\World of Warcraft\.build.info`） |
| 本机 apidoc 镜像 | `D:\AI\Workspaces\WOW\_apidoc\12.1.0\`（613 个文件）+ `12.0.7\`，来源 Gethe/wow-ui-source tag **12.1.0**（commit `09b9db79…`） |
| 12.1.5 镜像 | **不存在** |

`_apidoc` 目录在插件目录之外，任务票禁止修改仓库外目录，故本次**未建立 12.1.5 镜像**。
下文对表全部基于 **12.1.0 apidoc**：它覆盖本插件引用的全部 API，但**不等于 12.1.5 的官方证明**。

### 3.2 品质材料逻辑引用的 API 逐项对表（对 12.1.0 apidoc）

| 引用点 | 官方 apidoc | 判定 |
|---|---|---|
| `C_TradeSkillUI.GetItemReagentQualityByItemInfo(itemInfo: ItemInfo) → quality: ?number` | `TradeSkillUIDocumentation.lua` | ✅ 存在，签名一致（传裸 itemID 属 `ItemInfo` 联合） |
| `C_TradeSkillUI.GetItemReagentQualityInfo(itemInfo) → info: ?CraftingQualityInfo` | `TradeSkillUIDocumentation.lua` | ✅ 存在 |
| `CraftingQualityInfo.quality: number` | `TradeSkillUITypesDocumentation.lua` | ✅ 字段存在 |
| `CraftingQualityInfo.iconChat: textureAtlas` | 同上 | ✅ 字段存在（`textureAtlas` = 字符串图集名） |
| 代码里 `info.quality or info.qualityID` 的 `qualityID` 兜底 | 该结构体字段为 `quality / icon / iconSmall / iconInventory / iconMixed / iconAppear / iconDissolve / barFill / barBackground / barBackgroundCap / barHighlight / iconChat / iconQuestObjective` | ❌ **`qualityID` 不存在**（`craftingQualityID` 属别的结构体）。是**永不命中的死兜底**，注释"个别版本叫 qualityID"无据 |
| `C_Item.GetItemInfoInstant(itemInfo) → …, icon: fileID, …` | `ItemDocumentation.lua` | ✅ 存在，第 5 个返回值取 icon 一致 |
| `C_Item.GetItemNameByID(itemInfo) → ?string` | 同上 | ✅ 存在 |
| `C_Item.GetItemInfo(itemInfo) → itemName…` | 同上 | ✅ 存在（名字兜底来源合法） |
| `C_Item.RequestLoadItemDataByID(itemInfo)` | 同上 | ✅ 存在 |
| `C_Item.GetItemCount(itemInfo, includeBank=false, includeUses=false, includeReagentBank=false, includeAccountBank=false) → count` | 同上 | ✅ 存在；调用 `getCount(id, true, false, true, true)` 与形参顺序**完全一致** |
| 事件 `GET_ITEM_INFO_RECEIVED(itemID: number, success: bool)` | `ItemDocumentation.lua` 事件表 | ✅ 存在 |
| `C_Bank.FetchPurchasedBankTabIDs(bankType: BankType) → purchasedBankTabIDs: table of BagIndex` | `BankDocumentation.lua` | ✅ 存在；返回元素类型就是 `BagIndex`，直接喂 `C_Container.GetContainerNumSlots(BagIndex)` 合法 |
| `Enum.BankType.Character` = 0 / `.Guild` = 1 / `.Account` = 2 | `ItemConstantsDocumentation.lua` | ✅ 三个成员与数值一致；代码只用 Character + Account |
| `Enum.BagIndex.Backpack`=0、`Bag_1..Bag_4`=1..4、`ReagentBag`=5 | `BagIndexConstantsDocumentation.lua` | ✅ 全部存在且数值一致（枚举共 20 个成员，含 `CharacterBankTab_1..6`=6..11、`AccountBankTab_1..5`=12..16） |
| `C_Container.GetContainerNumSlots(containerIndex: BagIndex) → numSlots` | `ContainerDocumentation.lua` | ✅ 存在 |
| `C_Container.GetContainerItemInfo(containerIndex: BagIndex, slotIndex: luaIndex) → ContainerItemInfo` | 同上 | ✅ 存在 |
| `CreateAtlasMarkup(atlas, w, h)` | **12.1.0 apidoc 里查无此命名空间/函数** | ⚠️ **无法用 apidoc 定罪**：它是 FrameXML 全局，与本项目既有的 `GetInventoryItemID` 同类（apidoc 不收录老式全局）。代码以 `type(CreateAtlasMarkup) ~= "function"` 守卫，取不到就退回文字符号，**失败安全** |
| 品质图集名 `Professions-Icon-Quality-Tier*` | apidoc 不含图集名资源表 | ⚠️ 仅出现在**测试装置**的默认造数里；插件本身不硬编码图集名，只读 `iconChat`。真机图集名未验证 |
| 注释引用的判据出处 `Blizzard_ProfessionsRecipeReagentSlot.lua` | 镜像只含 `Blizzard_APIDocumentationGenerated`，无该文件 | ⚠️ 该"暴雪自己的同名口径"引用**本机无法复核** |

### 3.3 计数口径审查

- 「当前角色」行：每个品质变体各调一次 `CurrentCounts`（`GetItemCount` 取「背/银/装备」），再逐项相加；
  `includeAccountBank=true` 只取一次，**战团银行不会被按品质重复计入**。
- 「其他角色」行：只读 `SL2_DB.chars[*].bags / .bank` 快照，按变体 ID 相加；与旧逻辑的差异仅是"多 ID 求和"。
- 品质变体的**发现**（`ForEachContainerItem`）**只用于归组，不参与计数** —— 这点在源码注释与实现中一致，无重复计数。
- 变体表按 `quality` 升序、同档按 itemID 排序；`showTiers` 仅当跨行合计出现 ≥2 个不同品质才开启（单品质材料保持旧版式）。
  跨角色 `seen` 去重的写法使"我有 1 星、小号有 5 星"也会给两行都加档标行，属有意行为。
- `AddTierLine` 插在 `lineIndexes[i]` 记录**之后**，不会打乱 `AnchorDetailColumn` 的固定像素列锚定。

---

## 4. 与 `origin/main` 的逐文件比对

比对方式：`git hash-object`（运行副本文件） vs `git rev-parse origin/main:<path>`。

| 文件 | `origin/main` blob | 运行副本 | 判定 |
|---|---|---|---|
| `Core.lua` | `21b4fc30…` | `21b4fc30…` | 相同 |
| `Scan.lua` | `24282d0c…` | `24282d0c…` | 相同 |
| `Tooltip.lua` | `1d68eba1…` | `1d68eba1…` | 相同 |
| `Options.lua` | `c70389e8…` | `c70389e8…` | 相同 |
| `Locales.lua` | `5b425ddd…` | `5b425ddd…` | 相同 |
| `StockTake.toc` | `84359a7e…` | `84359a7e…` | 相同 |
| `README.md` / `README.en.md` | `c2d60705…` / `a818b639…` | 同 | 相同 |
| `CHANGELOG.md` / `CHANGELOG.en.md` | `2e72fd9e…` / `20d5d82b…` | 同 | 相同 |
| `LICENSE.txt` | `e8760551…` | `e8760551…` | 相同 |
| `Media/StockTake-Icon.tga` | `d92d9814…` | `d92d9814…` | 相同 |
| `README.zhTW.md` / `CHANGELOG.zhTW.md` | 上游已删除 | 不存在 | 一致 |

**结论：运行副本 = `origin/main`（v1.0）字节级一致；与本地 `HEAD`（v0.9.7）不一致。**

---

## 5. 为什么本次**没有**同步运行副本

任务票要求"只有仓库检查通过后才同步运行副本"。本次判定为**禁止同步**：

本地工作区是 0.9.7，运行副本是 1.0。若按票面执行"从仓库同步运行副本"，将把游戏内正在使用的
1.0（含品质材料功能）**降级**回 0.9.7，属于任务票明令禁止的破坏性/静默覆盖行为。
正确的"使二者一致"只有一条路：把本地分支快进到 `origin/main` —— 那是移动分支指针的 Git 操作，
且会连带删除 `README.zhTW.md` / `CHANGELOG.zhTW.md`（任务票硬性规则 1 依赖这两个文件），
必须由用户决策，执行器不得代劳。

---

## 6. 本次唯一可确定的 12.1.5 兼容性缺陷：`.toc` 未声明 `120105`

```
## Interface: 120100, 120007, 120005        ← 本地 HEAD 与运行副本（origin/main）完全相同
```

WoW 的 `## Interface` 为 `MMmmpp`：`120100` = 12.1.0、`120007` = 12.0.7、`120005` = 12.0.5。
**本机客户端 12.1.5 对应 `120105`，列表里没有**，游戏会把插件标为"过期/不兼容"。

本机同客户端生态的旁证（`_retail_\Interface\AddOns` 下各插件 `.toc`）：

| 插件 | `## Interface` |
|---|---|
| `CraftPro` | `120105` |
| `ClickCleanse` | `120105` |
| `GearInsight`（及全部子模块） | `120105, 120100, 120007` |
| `Auctionator` | `120100, 120105, 16001, …` |
| `AutoSpellQueue` | `120000, 120001, 120005, 120007, 120100, 120105` |
| `EverythingDelves` | `120100, 120105, 120007` |
| `BugSack` / `!BugGrabber` | `…, 120100, 120105, 120007` |
| **`StockTake`** | **`120100, 120007, 120005`** ← 缺 `120105` |

**未修改**：本地工作区与上游同一行都缺 `120105`，且在任何版本号（0.9.7 / 1.0）上都没有决定"基准树"之前，
落笔会产生一处必然要在快进后被重做、并挡住快进的改动。该修复留待用户确认基准后执行（一行、纯增项）。

---

## 7. 测试装置审查（任务票验收第 6 项）

上游 `origin/main` 的 `tools/simple-smoke.js` 第 15 节（261 用例中的新增部分）已覆盖任务票要求的全部场景：

| 要求 | 用例 |
|---|---|
| 多品质（同角色） | 15a：1 星 1 + 5 星 9 → 总数 10、「背」相加、档标行 `|T…Tier1:16:16|t 1` / `|T…Tier5:16:16|t 9`、合计 10 |
| 多品质（跨角色） | 15b：自己 10 + 小号 3 = 合计 13，小号行同样给档标行 |
| 单品质 | 15c：不加档标行，数量照常 |
| 同名不同图标 / 同图标不同名 | 15h 合并、15d 不并入 |
| 无变体回退 | 15g：非品质物品完全不受影响 |
| 数据未加载 → 到货 | 15e：`nameLoaded:false` 时只显示已知品质，`deliverItemData` 触发 `GET_ITEM_INFO_RECEIVED` 后总数变 10、5 星档标行补上 |
| 战团银行独有的品质 | 15i：发现路径覆盖账号银行，且该 9 个计入「银」不计背包 |
| 名字/档号兜底来源 | 15j（`GetItemInfo` 兜底）、15k（`GetItemReagentQualityInfo.quality` 兜底） |
| 缓存失效 | 走 `DATA_CHANGED → ClearCache()`（清 `cache` / `cacheFifo` / `variantCache`）与第 11 节缓存上限用例；`GET_ITEM_INFO_RECEIVED` 路径另清一次 |
| 性能护栏 | 15f：未请求过加载时 `GET_ITEM_INFO_RECEIVED` 不重画 |

mock 桩与真机的对应关系（`tools/wow-mock.js`）已逐条标注 apidoc 出处，未发现凭空捏造的 API / 枚举成员；
`bankTabIDs: {0:[6,7,9], 1:[], 2:[12,14]}` 中的 ID 与 `Enum.BagIndex`（`CharacterBankTab_1`=6、
`CharacterBankTab_2`=7、`CharacterBankTab_4`=9、`AccountBankTab_1`=12、`AccountBankTab_3`=14）一致。

### 7.1 两处需要复核的建模假设

1. **`name` 与 `quality` 到货时序被耦合建模**：mock 在两个函数里都用 `m.nameLoaded === false` 同时让
   `GetItemNameByID` 与 `GetItemReagentQualityByItemInfo/Info` 返回 nil（mock 注释亦承认"真机上品质信息
   要不要等数据到货无法确证"）。但插件 `MetaOf` 的逻辑是：
   `quality == nil and name == nil` → 不作为结论；**`quality == nil` 而 `name ~= nil` → 写 `metaCache[id] = false` 永久负缓存**，
   而 `metaCache` 在整个文件里**从不被清除**（`ClearCache()` 不碰它）。
   若真机上 `quantity` 比 `name` 晚到货（两者是独立数据），该品质会在**整个会话内**被永久判定为"不是品质材料"、永不归组。
   装置的耦合建模恰好**掩盖**了这条路径。建议补一条"name 先到、quality 后到"的用例，或把负结论改为可重试。
2. **档标图集名只能用合成值验证**：mock 在被测数据未给 `iconChat` 时造
   `'Professions-Icon-Quality-Tier' + n`。插件只读 `info.iconChat`，不硬编码图集名，故不构成"装置提供真机不存在的 API"；
   但"真机 `iconChat` 确实能渲染出那一枚品质图标"这一点**本机无法验证**。

---

## 8. 未完成 / 无法验证项

1. **未完成 12.1.5 兼容性证明**：本机无 12.1.5 官方 apidoc 镜像（只有 12.1.0 / 12.0.7），
   客户端 CASC 内的 `Blizzard_APIDocumentationGenerated` 未提取。按任务票要求，此项**报告为阻塞**，
   不得声称通过。
2. `CreateAtlasMarkup` 的存在性与签名本机无法用 apidoc 证明（FrameXML 全局）。
3. `Blizzard_ProfessionsRecipeReagentSlot.lua` 的"同名口径"出处无法复核。
4. 品质材料的真机渲染（档标图集、行高、版式）无法在无头装置外验证。
5. `CraftingQualityInfo.qualityID` 已确认不存在；该兜底为死代码，注释不实（不影响功能）。
6. 游戏内 `.toc` 兼容标记的实际表现（"过期"角标）未在客户端内实测。

---

## 9. 后续建议（供用户决策，本次未执行）

1. **先确定基准树**：把本地 `main` 快进到 `origin/main`（`ea5fb25`，v1.0），
   使仓库工作区与运行副本回到同一基准；注意这会删除 `README.zhTW.md` / `CHANGELOG.zhTW.md`
   （上游 `3813a10` 的决定），届时任务票硬性规则 1「三语文案」需改口径为「双语 + 游戏内三语 Locales」。
2. 在 1.0 基准上做**一行**修复：`## Interface: 120100, 120007, 120005` → 追加 `120105`。
3. 修正 `check_zhtw` 关卡口径：任务票给的 `node tools/check-zhtw.js … StockTake.toc` 必然假阳性；
   仓库已无繁体文档，脚本按现状应只用于 `Locales.lua` 的 zhTW 区块（且必须显式传参——
   上游 `AGENTS.md` 写的无参调用会直接退出码 2）。
4. 按需建 12.1.5 apidoc 镜像（`_apidoc\README.md` §"升级到新补丁"），再做第 5 道关卡。
5. 视结论补 `name` / `quality` 独立到货的回归用例（见 §7.1）。
