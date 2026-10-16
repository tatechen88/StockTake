---
created: 2026-10-16
updated: 2026-10-16
tags: [StockTake, 审计报告, WoW, 12.1.5]
---

# StockTake 12.1.5 兼容性修复与验证（任务票 StockTake-002）

> 执行日期：2026-10-16｜执行者：DSH 执行器｜模型：deepseek-v4-pro
> 本报告是 [12.1.5 兼容性核对（StockTake-001）](audit-12.1.5-兼容性核对.md) 的后续：
> 001 只做只读核对并在"基准树未定"处停下；002 由用户授权后**先快进、再在 v1.0 基准上修复**。
> 001 报告中的事实与数据原样有效，本文只记录快进与修复带来的变化。

---

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 快进 | `44c2014`（0.9.7）→ `ea5fb25`（v1.0），10 个提交，**无冲突 fast-forward**，未用 `reset --hard` |
| 用户改动 | `Media/StockTake-Icon.tga` 的既有删除状态**保留未动**；001 的审计报告**保留未动** |
| 修复项 | 4 项全部完成（`.toc` / 品质负缓存 / 死兜底 / check-zhtw 误报），版本 1.0 → **1.0.1** |
| 关卡 | 5 道全部通过（测试 261 → **265**，新增 4 条用例） |
| 第 5 道关卡 | **已在真正的 12.1.5 官方 apidoc 上跑过**：10 个引用点 / 0 问题（001 的最大的阻塞项已解除） |
| 运行副本 | 已同步 4 个有内容变化的文件，同步后 11 个运行文件与仓库 SHA256 逐一相同，无降级 |
| 未做（任务票明确禁止） | 未提交、未推送、未建 PR、未上传 CurseForge |

---

## 1. 基线快照与快进（任务票要求 1）

### 1.1 快进前

```
$ git rev-parse HEAD
44c2014a3a7ef19a6369801488d876f4af2e3230        # ## Version: 0.9.7
$ git rev-parse origin/main      （fetch 后）
ea5fb2593268fdd4ee0e4fbb4f65f8092ded99c5        # ## Version: 1.0
$ git merge-base --is-ancestor HEAD origin/main ; echo $?
0                                               # 确认为快进关系
$ git status --porcelain
 D Media/StockTake-Icon.tga
?? docs/reports/audit-12.1.5-兼容性核对.md        # 001 的报告（未跟踪）
```

### 1.2 快进命令与结果

```
$ git fetch origin
$ git merge --ff-only origin/main
Updating 44c2014..ea5fb25
Fast-forward
 .pkgmeta | AGENTS.md | CHANGELOG{,.en,.zhTW}.md | README{,.en,.zhTW}.md | StockTake.toc
 Tooltip.lua | docs/README.md | docs/curseforge-description.md
 tools/api-audit.js | tools/package-lock.json | tools/simple-smoke.js | tools/wow-mock.js
 16 files changed, 815 insertions(+), 383 deletions(-)
 delete mode 100644 CHANGELOG.zhTW.md
 delete mode 100644 README.zhTW.md
$ git rev-parse HEAD
ea5fb2593268fdd4ee0e4fbb4f65f8092ded99c5
```

快进后 `git status --porcelain` 与快进前**逐字相同**（仍是那一条 ` D Media/StockTake-Icon.tga`
与两条未跟踪的报告）——用户改动与 001 报告均未被触碰。

> **口径变化（由上游 `3813a10` 决定，非本次改动）**：繁体 README / CHANGELOG 已从仓库移除，
> 文档改「中文 / English」双语；**游戏内三语**（`Locales.lua` 三张表 + `.toc` 的 `Title-*` /
> `Notes-*`）保持不变。`AGENTS.md` 硬性规则 1 在快进后已同步为该口径。

---

## 2. 修复清单（任务票要求 3）

### 2.1 `.toc` 声明 12.1.5（`StockTake.toc`）

```diff
-## Interface: 120100, 120007, 120005
+## Interface: 120105, 120100, 120007, 120005
```

纯增项，原有三个兼容 Interface 全部保留。本机客户端为 12.1.5（`.build.info`），
同客户端生态的旁证见 001 报告 §6。顺带把 `## Version` 升到 `1.0.1`（见 §2.5）。

### 2.2 品质材料 `MetaOf` 的永久负缓存（`Tooltip.lua`）

**原实现**：`quality == nil and name ~= nil` → `metaCache[itemID] = false`（注释写"定论"）。
`metaCache` **从不被 `ClearCache()` 清理**，所以一旦真机是"名字先到、品质后到"，
该品质会在**整个会话内**被永久判为"不是品质材料"，永不归组、数量少一截。

**改为**：把"品质读不到"与"确认不是品质材料"分开。

| 读到的内容 | 旧行为 | 新行为 |
|---|---|---|
| `icon == nil`（客户端没这个 ID） | `metaCache = false` | 不变（真定论） |
| `name == nil` | 临时表，不缓存 | 不变（临时结论） |
| `name` 有、`quality == nil` | **`metaCache = false`（永久）** | **临时表，不缓存**；下次重试 |
| `name` + `quality` 都有 | 缓存 meta | 不变 |

配套两处：

- `CollectVariants` 的候选分支由"名字或品质缺一就请加载"改为**同图标即请加载**
  （仍受"图标相同"这道限量门禁约束），否则"品质后到货"永远不会被触发；
- `RequestItemData` 增加 **按 ID 去重**（`loadRequested` 表）。提示框随鼠标移动反复重建，
  不去重就会对同一件反复发请求。事件 `GET_ITEM_INFO_RECEIVED(itemID, success)` 带 itemID，
  到货的那件从等待表摘掉；`ItemLoadPending()` = 等待表非空，取代原先的单个布尔量
  （同时保留了 15f 那条"登录阶段没请求过就不重画"的性能护栏）。

代价：名字可读而品质始终读不到的物品（绝大多数普通物品）不再被写死，会在每次悬停时重新问
两次客户端缓存（非材料时 `GetItemReagentQuality*` 立即返回 nil），并对同图标候选做**一次**
去重后的加载请求。相对于"整个会话永久漏数"，这个代价是划算的。

### 2.3 删除不存在的 `CraftingQualityInfo.qualityID`（`Tooltip.lua`）

```diff
-            local quality = info.quality or info.qualityID
+            local quality = info.quality
```

12.1.5 官方 apidoc（本次新建的镜像）实查：

```
$ python apidoc_query.py struct CraftingQualityInfo
STRUCT CraftingQualityInfo   (ns TradeSkillUITypes, 来源 TradeSkillUITypesDocumentation.lua)
    quality: number
    icon / iconSmall / iconInventory / iconMixed / iconAppear / iconDissolve
    barFill / barBackground / barBackgroundCap / barHighlight / iconChat / iconQuestObjective
```

**没有 `qualityID`**（12.1.0 亦然）。原兜底永不命中，注释"个别版本叫 qualityID"无据，已删并
在注释里写明为什么删。

### 2.4 `check-zhtw.js` 对 `.toc` 的误报（`tools/check-zhtw.js`）

原脚本只对 `.lua` 识别 `local zhTW = {` 区块，**其余文件一律全文检查**。于是任务票给的命令
`node tools/check-zhtw.js README.zhTW.md CHANGELOG.zhTW.md Locales.lua StockTake.toc`
必然假阳性：`.toc` 里本该是简体的 `## Title-zhCN:` / `## Notes-zhCN:` 与中文注释被报成
"繁体里的简体字"（001 报告实测 12 处）。

改为按文件类型收窄范围：

| 文件类型 | 检查范围 |
|---|---|
| `.lua` | `local zhTW = {` 区块（不变） |
| `.toc` | **只查 `## Title-zhTW:` / `## Notes-zhTW:` 两行** |
| 其他 | 全文（不变） |
| 任何 | 文件不存在 → `SKIP`（繁体文档已在上游移除，缺失不是失败） |

**双向验证**（不能只证明"不再误报"，还要证明"真混简体仍然抓得住"）：

```
$ node tools/check-zhtw.js StockTake.toc
OK   StockTake.toc  (Title-zhTW / Notes-zhTW 行)        合计命中：0    退出码 0

# 反例：把 Title-zhTW 的「數量盤點」改成「数量盘点」
FAIL bad.toc  (Title-zhTW / Notes-zhTW 行，3 处简体字)
   L1  数 → 數 | ## Title-zhTW: |cffe6b84c数量盘点|r
   L1  盘 → 盤 | …
   L1  点 → 點 | …                                      退出码 1
```

### 2.5 三/双语文档同步

- `CHANGELOG.md` / `CHANGELOG.en.md`：各自新增 **1.0.1 — 2026-10-16** 段（中文 / English 同改），
  内容一致：`.toc` 120105、品质后到货不再误判、删除 `qualityID`、12.1.5 镜像与测试数变化。
- `StockTake.toc`：`## Version: 1.0 → 1.0.1`。
- `Locales.lua` 三张表、`.toc` 的 `Title-*` / `Notes-*`：**未改**（本次无任何玩家可见文案变化，
  所以三语表无需同改）。
- `README.md` / `README.en.md`：未改（文中不含版本号或 Interface 号，逐行核对过）。
- `tools/upload-to-curseforge.ps1`：**只改注释**。原文写"下面三项对应 toc 声明的
  Interface 120100 / 120007 / 120005"，加了 120105 后这句不再准确。12.1.5 的 CurseForge
  版本 ID **本机无法核实**（权威来源 `GET /api/game/versions` 要 `X-Api-Token`，本仓库不查），
  故**没有**动 `$GameVersions` 数组，只在注释里写明"上线 1.0.1 前先查一次"。

---

## 3. 关卡原始结果（任务票要求 5）

全部在修复后的工作区上执行（`HEAD` = `ea5fb25` + 未提交的工作区改动）：

| # | 命令 | 原始结果 | 退出码 |
|---|---|---|---|
| 1 | `node tools/lua-check.js .` | `语法校验: 5 通过 / 0 失败 / 0 缺失（共 5 个 .lua）` | 0 |
| 2 | `node tools/api-audit.js .` | `API 审计: 5 个文件, 0 个 ERROR, 0 个 WARN` | 0 |
| 3 | `node tools/simple-smoke.js` | `汇总：265 用例，265 通过，0 失败` | 0 |
| 4 | `node tools/check-zhtw.js README.zhTW.md CHANGELOG.zhTW.md Locales.lua StockTake.toc` | `SKIP README.zhTW.md（文件不存在）` / `SKIP CHANGELOG.zhTW.md（文件不存在）` / `OK Locales.lua (local zhTW 区块)` / `OK StockTake.toc (Title-zhTW / Notes-zhTW 行)` / `合计命中：0` | 0 |
| 5 | 官方 apidoc 对表（12.1.5，见 §4） | `已核对 API 引用点: 10` / `发现问题: 0` | 0 |

### 3.1 新增回归用例（15m）

`tools/simple-smoke.js` 第 15 节新增 4 条断言（261 → 265）：

```
15m 名字先到、品质后到：不得写成永久负缓存
  · 品质未到货时先按已知的那一件显示
  · 名字已可读但品质未到货时也要请客户端加载
  · 品质到货后自动重画并归组：总数变 10
  · 后到货的 5 星星标行补上
```

**变异验证（红过才算数）**：把 `MetaOf` 临时改回旧行为（名字可读 + 品质 nil → 永久负缓存），
同一套件立即 3 条失败，且失败信息就是症状本身：

```
汇总：265 用例，262 通过，3 失败
  ✗ 15) 名字已可读但品质未到货时也要请客户端加载（否则品质永远到不了）
  ✗ 15) 品质到货后自动重画并归组：总数变 10（实际：… TestChar|r: 1    （背 1） 合计: 1）
  ✗ 15) 后到货的 5 星星标行补上
```

随后从备份恢复，`Tooltip.lua` SHA256 与变异前逐字节一致
（`AC2EC0A6…B3DA1`，恢复后复核 `restoredOk=True`）。

### 3.2 测试装置（`tools/wow-mock.js`）的同步加固

001 报告 §7.1 已指出装置把"名字到货"与"品质到货"**耦合建模**（同一个 `nameLoaded` 同时决定
两者），恰好掩盖了本次要修的那条路径。装置因此拆成两个独立开关：

- `itemMeta[id].nameLoaded === false` → `C_Item.GetItemNameByID` / `GetItemInfo` 返回 nil；
- `itemMeta[id].qualityLoaded === false` → `C_TradeSkillUI.GetItemReagentQuality*` 返回 nil；
- `deliverItemData(id)`（名字+品质一起到货，原语义不变）与新增 `deliverItemQuality(id)`
  （**只送品质**，名字此刻已可读），都派发 `GET_ITEM_INFO_RECEIVED(id, true)`。

两个开关在真机上的对应物都是"服务端物品数据的两个部分"，不是凭空造的 API。

---

## 4. 12.1.5 官方 apidoc 阻塞项**已解除**（任务票要求 4）

001 报告把"无 12.1.5 官方镜像"列为唯一阻塞项。本次确认镜像可建并已建：

| 项 | 值 |
|---|---|
| 上游 | `Gethe/wow-ui-source` tag `12.1.5`，commit `18c6d677b605b312f3d813d498404631fb941977` |
| 镜像 | `D:\AI\Workspaces\WOW\_apidoc\12.1.5\`（**623** 个文件，取自 `Blizzard_APIDocumentationGenerated`） |
| 索引 | `_apidoc\api-12.1.5.json`（620 命名空间 / 6400 函数 / 1782 事件 / 1691 结构体） |

第五道关卡在 12.1.5 索引上运行（`check_project_api.py` 的 `scan_file` 直接复用其掩码与正则，
只把 `INDEX` 指向 `api-12.1.5.json`，**未修改该共享工具**）：

```
已核对 API 引用点: 10
发现问题: 0
```

同时逐条实查了 12.1.5 里本插件依赖的关键签名（与 12.1.0 一致）：

| API | 12.1.5 官方签名 | 判定 |
|---|---|---|
| `C_TradeSkillUI.GetItemReagentQualityByItemInfo` | `args(itemInfo: ItemInfo)` → `ret (quality: ?number)` | ✅ |
| `C_TradeSkillUI.GetItemReagentQualityInfo` | `args(itemInfo: ItemInfo)` → `ret (info: ?CraftingQualityInfo)` | ✅ |
| `CraftingQualityInfo.quality` | `quality: number` | ✅ |
| `CraftingQualityInfo.qualityID` | **不存在** | ✅ 已删兜底 |
| `C_Item.GetItemCount` | `args(itemInfo, includeBank=false, includeUses=false, includeReagentBank=false, includeAccountBank=false)` → `ret (count: number)` | ✅ 与调用一致 |
| `C_Item.GetItemNameByID` | `args(itemInfo)` → `ret (itemName: ?string)` | ✅ |

### 4.1 仍未验证 / 仍无法验证（不得当作通过）

1. **游戏内实机行为未实测**：`.toc` 过期角标消失、品质档标真机渲染（`iconChat` 图集）、
   12.1.5 下的行高与版式——都需要在游戏里看，本次没有做（任务票未要求，且"不进行破坏性游戏内操作"）。
2. `CreateAtlasMarkup`（FrameXML 全局）依旧不在 apidoc 内，存在性与签名本机无法用 apidoc 证明；
   代码以 `type(...) ~= "function"` 守卫，失败安全。
3. `Blizzard_ProfessionsRecipeReagentSlot.lua` 的"同名即同品质变体"出处依旧无法在本机复核
   （镜像只含 `Blizzard_APIDocumentationGenerated`）。
4. "品质数据比名字晚到货"在真机上**是否真会发生**，本机无法确证——本次修的是"如果发生就必须正确"
   的那条路径，不声称它一定发生。

---

## 5. 运行副本同步（任务票要求 6）

路径：`D:\Game\World of Warcraft\_retail_\Interface\AddOns\StockTake`

### 5.1 同步前 → 同步后（逐文件 SHA256）

| 文件 | 同步前 | 同步后 | 与仓库 | 动作 |
|---|---|---|---|---|
| `Tooltip.lua` | `9467794E…97BF39` | `AC2EC0A6…52B3DA1` | 相同 | **已同步**（有源码修复） |
| `StockTake.toc` | `AACA337D…486F9AF` | `3B773AA3…AA9D161` | 相同 | **已同步**（120105 + 1.0.1） |
| `CHANGELOG.md` | `7DC1DFC3…4F92AB4` | `9A4AA35B…21DA88E7` | 相同 | **已同步**（1.0.1 段） |
| `CHANGELOG.en.md` | `304FAFA5…E9E03218` | `C44D7EE5…490EDF6C` | 相同 | **已同步**（1.0.1 段） |
| `Locales.lua` | `16DBF119…8951BBCE` | 不变 | 相同 | 未动（内容已一致） |
| `Core.lua` | `C645C876…FBC43266` | 不变 | 相同 | 未动 |
| `Scan.lua` | `862AEA80…50A0B4D0` | 不变 | 相同 | 未动 |
| `Options.lua` | `964AD055…51BF9189` | 不变 | 相同 | 未动 |
| `README.md` | `AA0A9A55…93C864458` | 不变 | 相同 | 未动 |
| `README.en.md` | `27332822…E0567F8F1` | 不变 | 相同 | 未动 |
| `LICENSE.txt` | `40E61A1E…3DCD3E` | 不变 | **不同（仅行尾）** | **未动**，见 §5.2 |
| `Media\StockTake-Icon.tga` | `68C102A1…A392F30B` | 不变 | 仓库工作区已删除 | **未动**（任务票明令保留） |

同步后 10 个「与仓库相同」的文件全部逐一复核为 `matchRepo=True`。

### 5.2 两处刻意**未同步**的文件（同步不得降级）

1. **`LICENSE.txt`**：仓库工作区是 LF（1066 字节），运行副本是 CRLF（1087 字节），
   **去掉行尾差异后内容完全相同**（`contentEqualIgnoringEOL=True`）。运行副本并没有比仓库旧，
   反而是"更 Windows 原生"的形态；复制过去等于把运行副本降级成另一种行尾，属于无意义的改动，
   故保留原样。
2. **`Media\StockTake-Icon.tga`**：用户既有删除状态（仓库工作区无 `Media/` 目录），
   任务票明令保留；运行副本里该文件与仓库 `HEAD` 的 blob 一致（`68C102A1…A392F30B`），
   保持不动既没降级也没丢资产。

> 游戏只加载 `.toc` 列出的 5 个 Lua，其余文件不影响加载；运行副本当前 12 个文件，
> 与同步前一致（未增未删）。

---

## 6. 未完成 / 交给后续

1. **提交与发布未做**（任务票禁止）：工作区现有 8 个已修改文件 + 2 份未跟踪报告，
   等待独立验收（Codex）后再由用户决定是否提交。
2. **CurseForge 12.1.5 版本 ID 未核实**（见 §2.5）；真要上线 1.0.1 前补进
   `upload-to-curseforge.ps1` 的 `$GameVersions`。
3. `tools/build-release.ps1` 未运行（本次不打包）。它只校验 `.toc` 引用的文件与资源路径前缀，
   与本次改动无关；但若下次打包，`.toc` 新增的 Interface 号对它是纯数据，不影响校验。
4. 001 报告 §7.1 的另一条建模假设（档标图集名只能用合成值验证）依旧存在，属真机不可验证项。
