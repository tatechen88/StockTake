# 审计 B · 需求覆盖与产品完整性报告

> 审计员：B（独立，未参与开发）· 视角：挑剔用户 + 发布审核员
> 被审对象：`D:\Game\World of Warcraft\_retail_\Interface\AddOns\StackLedger\`（v0.7.0）
> 比对基准：`需求清单-审计用.md`（§A A1-A17 / §B 质量 / §C 环境 / §D 历史 / §E 疑点）
> 实测：三道关卡均绿（lua-check 5/5 · api-audit 0 ERROR/0 WARN · simple-smoke **89/89**）

---

## 1. 需求覆盖表（A1–A17）

| # | 需求 | 判定 | 证据（文件:行） |
|---|---|---|---|
| A1 | 背包/其他角色/银行数量 | ✅ 已满足 | 当前角色实时：Tooltip.lua:16-31（`C_Item.GetItemCount`）；其他角色：Tooltip.lua:46-59 读 `SL2_DB.chars`，由 Scan.lua 记录 |
| A2 | 战团并入"银"，不单独分类 | ✅ 已满足 | 并入参数：Tooltip.lua:24-25 `includeAccountBank=true`；Scan.lua:44-57 `BankIDs()` 仅 `Enum.BankType.Character` + `BankBag`，**无任何战团扫描/存储/独立行残留** |
| A3 | 仅 3 项设置 | ✅ 已满足 | Options.lua:128-130（2 勾选 + 1 滑条），无其他控件 |
| A4 | 全局字号，默认 0=跟随游戏 | ✅ 已满足 | 默认：Core.lua:10 `fontSize=0`；生效判断：Tooltip.lua:101-106 `<=0 → nil`（不干预） |
| A5 | 5 文件、零第三方库、无导入、`SL2_DB` | ✅ 已满足 | .toc:12-16 共 5 个 .lua；SavedVariables=.toc:8；Core.lua:23 读 `SL2_DB`；无 `require`/第三方库 |
| A6 | 暴雪原生控件 | ✅ 已满足 | Options.lua:15-18 `SettingsCheckboxTemplate`/`SettingsSliderTemplate` + 自建 FontString 标签 |
| A7 | 去掉"启用插件"开关 | ✅ 已满足 | Core.lua:9-14 DEFAULTS 无 `enabled`；冒烟断言 simple-smoke.js:132 `enabled===undefined` |
| A8 | 去掉悬停反白背景 | ✅ 已满足 | Options.lua:58-73 接管 OnEnter/OnLeave、`HoverBackground:Hide()` |
| A9 | 勾选框必须有文字 | ✅ 已满足 | Options.lua:36-56 `OwnLabel`（带锚点 FontString）+ `SetLabel(forceOwn=true)` |
| A10 | 字号对所有行生效 | ✅ 已满足 | Tooltip.lua:120-152 全局扫描 `TextLeftN/TextRightN` + `GetRegions` 兜底 |
| A11 | 数量块上下各一空白行 | ✅ 已满足 | Tooltip.lua:282、299 `AddLine(" ")`；仅 `#rows>0` 时（:280 守卫） |
| A12 | 当前角色名下红色下划线 | ✅ 已满足 | Tooltip.lua:154-181（1px 纹理）、:303-311 锚定；OnHide/非物品隐藏 |
| A13 | 插入位置"原生说明之后"，三路径（行回调/兜底/ItemRef） | ⚠️ 部分满足 | 行回调 Tooltip.lua:372-380、兜底 :382-384 **两路径齐备**；但 **ItemRef 无独立插入逻辑**——ItemRefTooltip 仅 `EnsureShowHook` 做字号/下划线（:204），插入完全依赖 `TooltipDataProcessor` 通用 Item 流程是否覆盖物品链接，且**无头测试未覆盖 ItemRef 插入**（simple-smoke 只走 `invokeItemTooltipFlow`→GameTooltip）。见 §6 F1 |
| A14 | 英文版本 | ✅ 已满足 | README.en.md + Locales.lua:27-46 enUS 表；括号半角带空格（:39） |
| A15 | 括号与数量隔 5 格 | ✅ 已满足 | Locales.lua:18 `"     （"` / :39 `"     ("`（各 5 空格） |
| A16 | 多角色括号对齐（仅多行） | ✅ 已满足 | Tooltip.lua:227 `#rows<2 → return`；按像素补白 :226-271 |
| A17 | `/sl en`/`zh`/`auto` 即时切换 | ✅ 已满足 | Options.lua:186-198；SL.L 代理 Locales.lua:61-66（每次取值解析当前语言） |

**小结**：A1–A12、A14–A17 共 16 条满足；**A13 部分满足**（ItemRef 第三条路径在代码里不存在/未验证）。

---

## 2. 发布就绪（CurseForge）发现

### P2-1 缺 LICENSE 文件
- 位置：插件目录 `D:\Game\...\StackLedger\`（glob 仅 9 个文件：5 .lua + .toc + README.md + README.en.md + CHANGELOG.md，无 LICENSE）
- 问题：公开发布无许可证，默认"保留所有权利"，CurseForge 审核与合规上属缺失；README 已声明面向 CurseForge（README.en.md:1-3），应配套。
- 建议：加 `LICENSE`（MIT 最省事），并在 `.toc` 可选加 `## X-License: MIT`。

### P2-2 文档含本机绝对路径（应清理）
- 位置：
  - README.md:86-91（`D:\AI\Workspaces\WOW\StackLedger-简化版规划.md`、`D:\AI\Workspaces\WOW\StockTake-dev\tools\`）
  - README.en.md:88-93（同上）
  - CHANGELOG.md:312（`D:\AI\Workspaces\WOW\StockTake-dev\archive\v0.1.0-complex\`）
- 问题：发布包泄漏个人盘符/目录结构；其他用户点开是死链，且不专业。
- 建议：README 开发者段落改为"仓库内相对路径/说明"或整体删除；CHANGELOG 归档路径改为相对表述。

### P2-3 `.toc` 缺 `## X-Website`（X-* 完整性）
- 位置：StackLedger.toc:1-9
- 现状：有 `## Title`/`Title-zhCN`/`Notes`/`Notes-zhCN`/`Author`/`Version`/`SavedVariables`/`X-Category: Bags & Inventory`；**缺 `## X-Website`**（无 CurseForge/WoWI 项目页链接），也缺 `## X-CurseForge-ID`/`## X-License`。
- 建议：上线拿到项目 URL 后补 `## X-Website`；`X-Category` 值 `Bags & Inventory` 建议再与 CurseForge 当前分类列表核对一次。

### P3-1 打包（zip 结构）无说明/脚本
- 位置：README 仅教手动安装（README.md:36-38 / README.en.md:35-37）；StockTake-dev 下无打包脚本（glob *.ps1/*.bat 无）。
- 建议：README 或发布说明补一句"CurseForge 包 zip 内顶层目录必须为 `StackLedger`（目录名=插件名）"；可选加 `package.ps1`。

### P3-2 CHANGELOG 20.7KB 建议拆分/归档
- 位置：CHANGELOG.md（21164 字节，0.1.0→0.7.0 全量）
- 建议：发布 zip 可排除 CHANGELOG.md 或只保留近 2–3 版（0.6/0.7），旧版归档到 repo 的 `CHANGELOG.archive.md`；CurseForge 页用网站 changelog 字段，不必整包带上。

---

## 3. 文档与行为一致性

### P3-3 README 行数/用例数过期（中英两份）
- 位置：README.md:5「约 450 行」、README.md:90「75 用例」；README.en.md:5「~470 lines」、README.en.md:92「75 cases」
- 实测：**5 个 Lua 共 888 行**（Core 127 / Tooltip 392 / Scan 104 / Options 199 / Locales 66）；冒烟测试实跑 **89 用例**。`需求清单` 第 4 行的「785 行」同样过期。
- 建议：统一改为「5 files · 888 lines（或去掉行数，只写"5 个文件、零第三方库"）」；用例数改 89（或去掉具体数字，避免每次递增都改文档）。

### P3-4 README 示例用「━━━」字符表下划线，与实际不符
- 位置：README.md:20 / README.en.md:20（`━━━━…` 画成独立行）
- 实际：1px 纹理锚定在当前角色行下方（Tooltip.lua:156-181），**不是一条字符行**，不占行高。
- 建议：示例把下划线画成紧贴"当前角色"行下方的一条细线（或加注释"1px 细线，非字符行"）。

### P3-5 字号滑条 1–5 显示但实际 clamp 到 6
- 位置：Options.lua:130（min 0）、Tooltip.lua:104（`<FONT_MIN(6)` 钳到 6）
- 问题：滑条可在 1–5 停留、`valueText` 显示"3"，但实际字体是 6，用户看到的数字≠生效字号。
- 建议：滑条 min 设为 6（保留 0=跟随游戏单独呈现），或 1–5 也精确生效；README.md:73 已暗示"拖到 6–32 才生效"，与滑条 UI 自相矛盾。

### ✅ 已核对一致（见 §6 清单）：示例 5 格间距、明细括号、对齐、"原生说明之后/其他插件之前"的位置、3 项设置文案与控件、`/sl en` 等命令两 README 都写。

---

## 4. 用户旅程缺口（新用户视角）

### P2-4 换服/改名后角色残留，无清理且未文档化
- 位置：无清理功能（Scan/Core/Options 均无 forget/清理；仅 3 控件）。角色键=`realm-name`（Core.lua:102）。
- 问题：转服/改名后旧 `realm-旧名` 记录永久残留，仍以"一个角色"显示陈旧数量；README 未提。新用户一旦遇到会困惑（"这个号我早删了怎么还显示"）。
- 建议：README FAQ 补一条「换服/改名会留下旧记录（简化版无清理），删除 `WTF\Account\<账号>\SavedVariables\StackLedger.lua` 可整体清空重建」。属已知产品限制，必须文档化。

### P3-6 "谁都没有 → 什么都不显示"未明确
- 位置：README FAQ 只解释了"其他角色一开始不显示"（README.md:63-64），未说"**当前角色也没有时，整块完全不出现**（含空行/合计）"。
- 建议：补一句，避免首次悬停无数据时误以为插件坏了。

### ✅ 已讲清：需各角色登录一次（README.md:63-64）、银行需开银行界面才记录其他角色（:64）、当前角色"银"含战团（:66-67）。当前角色自身背包/银行走 API 实时、无需登录银行（Tooltip.lua:24-25 语义）——README 表述与实现一致。

---

## 5. 与旧插件共存

### P2-5 README 未提醒"同时启用旧计数插件会看到两份数据"
- 位置：README.md:76-77「和别的插件冲突吗」只讲了**字号滑条**与皮肤插件的冲突，**完全没提 ItemCountTooltip 等旧计数插件的"重复计数"**。
- 背景：环境事实 §C「用户已手动停用 ItemCountTooltip，但仍安装在 AddOns 目录」——这正是最容易误导新用户的场景：装上 StackLedger 又保留/误启用旧计数插件 → 悬停看到两套重复数字，分不清谁是谁。
- 建议：README.md + README.en.md 的 FAQ/冲突段明确加一句「若同时启用其他计数插件（如 ItemCountTooltip），提示框会出现两份数量；请二选一停用」。

---

## 6. 可维护性红旗

### P3-7 Locales 双表 + `SL.L` 代理的 `pairs()` 陷阱
- 位置：Locales.lua:61-66（`setmetatable({}, {__index=…})`，无 `__pairs`/`__newindex`）
- 问题：`SL.L` 是**空表**，`pairs(SL.L)`/`next(SL.L)` 返回空；任何未来代码或测试直接 `for k,v in pairs(SL.L)` 会静默拿到 0 个键。
- 现状：无生产代码遍历 SL.L；测试已绕开——simple-smoke.js:393 直接 `pairs(StackLedger.localeTables[which])`（CHANGELOG 0.7.0:24 也已注明）。因此**当前无 bug，是潜在坑**。
- 建议：给代理加 `__pairs`（Lua 5.2+）返回底层表；或在代理上加注释「禁止 pairs(SL.L)，遍历请用 SL.localeTables」；另注意 `CurrentLocale()` 每次取值重读 DB（每行每词条一次），量小可接受但可加缓存。

### P3-8 Tooltip.lua 重复声明 `FONT_MIN, FONT_MAX`
- 位置：Tooltip.lua:10 与 :98 两处 `local FONT_MIN, FONT_MAX = 6, 32`（同作用域重声明，第一处为死代码）
- 建议：删 :10 或 :98 之一。

### P3-9 CHANGELOG 引用本地路径
- 位置：CHANGELOG.md:312（`D:\AI\Workspaces\WOW\StockTake-dev\archive\...`），见 P2-2。
- 其余 CHANGELOG 引用如 `TooltipDataRules.lua:226`（CHANGELOG.md:159）是暴雪内部源码，合法。

---

## 7. 疑点 E1–E6 复核（审计员 B 视角）

| 疑点 | 复核结论 |
|---|---|
| E5 战团并入"银"依赖 `includeAccountBank` 第 5 参 | **已核对无问题**：该参数自 11.0 起存在，客户端 12.1.0 支持；测试装置 wow-mock.js:702 亦按第 5 参建模 |
| E6 语言切换不 Fire CONFIG_CHANGED，缓存需否失效 | **已核对无问题**：`cache[itemID]` 只存 `{name,class,bags,bank,total,isPlayer}` 数字+名字（Tooltip.lua:33-68），词条在 RowText 渲染时实时取 SL.L，故语言切换无需清缓存 |
| E1 悬停状态残留（非物品提示框误插） | **风险未证伪（交审计 A 做代码级确认）**：`OnAnyLine`（Tooltip.lua:330-336）无 `IsItemTooltip` 守卫，仅靠 `p.inserted`/`p.itemID`；若物品流程中断致 `inserted=false` 且残留 `lineCount`，后续同 GameTooltip 的单位提示框在 `lineIndex==lineCount` 巧合下可能插入残留物品的数量块。概率低（需流程中断 + 行号巧合），建议加一行 `if IsItemTooltip(tooltip)==false then return end` 守卫 |
| E2 append 模式误判、E3 测量顺序、E4 材料银行漏记 | 代码级细节，超出本审计（需求/发布）范围，建议交审计 A/C 专项 |

---

## 8. 已核对无问题清单（抽查实证）

- 三道关卡实跑全绿：lua-check 5/5 · api-audit 0 ERROR/0 WARN · simple-smoke 89/89。
- A2 无战团残留：Scan.lua 无 AccountBank 扫描/存储/行。
- A4 默认 0：Core.lua:10 + Tooltip.lua:101-106 双重保证。
- A16 对齐仅多行：Tooltip.lua:227 `#rows<2` 早退。
- A15 5 格间距：Locales.lua:18/39 中英各 5 空格，与 README 示例一致。
- 5 文件、`SL2_DB`、无 `require`/第三方库、`enabled` 键确实已删除（含冒烟断言）。
- 3 项设置文案与控件一一对应（README.md:44-48 vs Options.lua:128-130）。
- `/sl en`/`zh`/`auto` 命令两 README 均写（README.md:57-59、README.en.md:56-58）。
- "需各角色登录一次""银行开银行界面才记录""银含战团"FAQ 表述与实现一致。
- 配置键仍为 3 个持久键（locale 默认 nil 不占位，冒烟 simple-smoke.js:131 通过）。
- enUS 明细用半角括号 `(bags 2 · bank 3)`，无全角/中文残留（冒烟断言 simple-smoke.js:385）。

---

## 9. 分级汇总

**P1（发布阻塞）：无。** 未发现崩溃/数据丢失级缺陷。

**P2（发布前应处理）：**
1. P2-1 缺 LICENSE
2. P2-2 README/CHANGELOG 含本机绝对路径
3. P2-3 `.toc` 缺 `## X-Website`
4. P2-4 换服/改名残留无清理且未文档化
5. P2-5 未提醒与旧计数插件共存会双份数据
6. （功能风险）A13 的 ItemRef 插入路径未实现/未验证，需真实客户端确认点击物品链接是否出现数量块

**P3（打磨）：** P3-1 打包说明缺失 · P3-2 CHANGELOG 拆分 · P3-3 行数/用例数过期 · P3-4 下划线示例失真 · P3-5 字号 1–5 clamp 到 6 · P3-6 "谁都没有不显示"未明说 · P3-7 SL.L 代理 pairs 陷阱 · P3-8 重复声明 · P3-9 CHANGELOG 本地路径
