# 对抗审计报告 — C（测试与装置保真度）｜0.9.7

> 审计员路由：openai-subscription/gpt-5.6-sol（与编写者不同路由）｜日期：2026-09-30｜只读

## 1. 总结论

两项允许的只读关卡均通过：

- `node tools/simple-smoke.js`：**215/215 通过**
- `node tools/lua-check.js .`：**5/5 通过**

0.9.7 的主要成功链路已有有效覆盖：登录时建立装备表、同一物品占多个装备槽、装备从「背」中扣除、装备单独成列、装备-only 物品仍显示、换装后缓存失效并重放提示框，以及 FIFO 和空结果缓存的行为验证。相关 mock 也已删除真机不存在的装备计数 API，并正确表达 F1/F2 的 `GetItemCount` 口径。

主要不足是：两个 A7 API 缺失兜底完全未测，12h 的总数断言存在数字前缀误匹配，场景克隆漏掉一个可由 setter 修改的映射，装备参与多角色排序与合计的组合行为没有覆盖。

| 严重级别 | 数量 |
|---|---:|
| P0 | 0 |
| P1 | 0 |
| P2 | 2 |
| P3 | 3 |

## 2. 发现明细

### [P2] 装备 API 和槽位常量缺失兜底没有测试
**位置：** `tools/simple-smoke.js:887-936`；`tools/wow-mock.js:881-890`

A7 明确要求的两条防御路径没有测试：① `GetInventoryItemID` 缺失时，装备计数应保持全 0，插件不得崩溃；② `INVSLOT_FIRST_EQUIPPED` / `INVSLOT_LAST_EQUIPPED` 缺失时，应回落到 1–19。此外 `Core.lua:85` 对单槽查询使用 `pcall`，但也没有测试某个槽调用抛错后是否继续扫描其他槽。

**建议修法：** 增加三组独立测试（API 置 nil / 常量置 nil 且物品放 1 号与 19 号槽 / 单槽抛错其余正常）。

### [P2] 12h 总数断言存在数字前缀误匹配
**位置：** `tools/simple-smoke.js:935`

`self.indexOf(': 1') !== -1` 不只会匹配总数 `1`，也会匹配 `10`、`11`……`19`。因此它不是恒真，但可以接受一类明显错误的总数。该断言不会被合计行误匹配（`self` 已由 `lines.find(/TestChar/)` 限定），真正的问题是数字没有右边界。

**建议修法：** 至少改为 `/: 1(?:\s|（|\(|$)/`；更稳妥的是去颜色码后精确解析。装备-only 场景还应额外断言合计行也是 1。

### [P3] `cloneScenario` 漏拷 `tooltipItemLinks`
**位置：** `tools/simple-smoke.js:52-66`；`tools/wow-mock.js:1340-1343`

`setTooltipItemLink` 原地写入 `scenario.tooltipItemLinks`，但克隆名单没有该字段；若传入场景预置了它，多个 `load()` 会共享同一嵌套对象。当前共享 `SCENARIO` 未预置该字段，暂未发生实际污染。

**建议修法：** 纳入映射复制清单；最好加一条克隆契约测试。

### [P3] 装备参与多角色排序和合计的组合行为覆盖不足
**位置：** `tools/simple-smoke.js:887-936`；`Tooltip.lua:89-94`

装备测试没有同时加入其他角色，因此没有验证：当前角色即使装备总数较低仍固定置顶；其他角色仍按快照总数排序；合计行包含当前角色装备；其他角色的总数不出现装备成分；装备列对固定列宽与锚点的影响。

**建议修法：** 构造当前角色装备-only=1、AltA=9、AltB=3 的组合，断言顺序、合计=13、装备列只在当前角色行。

### [P3] `GetItemCount` 失败和异常返回路径缺少装置能力及测试
**位置：** `tools/wow-mock.js:754-768`；`Tooltip.lua:32-48`

mock 的 `GetItemCount` 永远成功，无法覆盖：基准调用失败、五参调用失败（E9 回落）、`all < carried`、`equipped > carried` 的夹零逻辑。

**建议修法：** 增加默认关闭的 fault-injection 配置并补四类测试。

## 3. E7 / E8 裁决

- **E7：确认（弱断言是真问题，但“被合计行误中”可证伪）。** `self` 已限定为当前角色行；问题是 `indexOf(': 1')` 的数字前缀。
- **E8：证伪。** 现有测试不依赖 `setEquipped` 的具体槽位分配；唯一调用是清除 item 700。若将来测试槽位事件载荷或槽型限制，应改用 `setEquip(slot, info)` 明确布置。

## 4. A11 装置保真核对结果

**通过（本次审计聚焦的 0.9.7 接口范围内）：**

1. `C_Item.GetEquippedCount` 与全局 `GetEquippedCount` 均不存在，并有门禁断言，符合 F4。
2. `Enum.BagIndex` 为 20 个成员、值域 -3..16、无 `BankBag`，逐项与 F5 的 apidoc 事实一致；`Accountbanktab/Characterbanktab` 的大小写是“逐字照抄 apidoc”口径，不应擅自规范化。
3. `GetInventoryItemID("player", slot)` 按槽返回 itemID，符合 F6；装备的唯一事实源是 `scenario.equip`，无并行假计数模型。
4. `GetItemCount` 一参基准取 `itemCount`（含装备、含背包材料包），第 2/4/5 参数分别累加角色银行/材料银行/战团银行——与 F1/F2/F3 相符。
5. 局限：mock 不从 `containers`/`equip` 自动推导 `itemCount`（测试作者可构造矛盾世界，属可控单元桩设计）；未对全部约 1370 行的每个非本次链路桩逐一全量重证。

## 5. 覆盖洞清单（按风险排序）

1. **高：** `GetInventoryItemID` 缺失、INVSLOT 常量缺失、单槽 API 抛错。
2. **高：** 五参 `GetItemCount` 失败，以及 `all < carried`、`equipped > carried` 等异常值夹零。
3. **中：** 装备参与“当前角色置顶、其他角色排序、合计”的组合行为。
4. **中：** 装备列在长角色名、大数字及三种语言下的固定列宽、换行和裁剪表现。
5. **低：** `setEquipped` 在满 19 槽、`count > 19`、负数等 helper 边界上的行为。
6. **低：** `tooltipItemLinks` 的场景隔离契约。
