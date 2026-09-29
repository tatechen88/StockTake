# 对抗审计报告 — A（代码正确性）｜0.9.7 装备计数链路

> 审计员路由：deepseek-official/deepseek-v4-pro（与编写者不同路由）｜日期：2026-09-30｜只读

## 1. 总结论

0.9.7 装备计数链路（`SL.equippedCounts` / `SL:RebuildEquipped` / `SL:GetEquippedCount` / `CurrentCounts` 三值拆分 / 事件注册分发 / FIFO 缓存失效）**逻辑正确，未发现已证实的 P0/P1/P2 缺陷**。唯一正确性风险是 E2（衬衫槽 4 / 战袍槽 19），属「无法确定」，且若成立仅为条件性 P2（只影响「背」，不影响「银 / 装备」）。

| 级别 | 数量 |
|---|---|
| P0 | 0 |
| P1 | 0 |
| P2 | 0（已证实） |
| P3 | 3 |

验证手段：`node tools/lua-check.js .`（5/5）、`node tools/simple-smoke.js .`（215/215）、`node tools/api-audit.js .`（0 ERROR / 0 WARN）；apidoc 12.1.0 本地镜像 + warcraft.wiki.gg 双源复核签名。

## 2. 发现明细

**[P3] 悬停中物品数量归零时红色下划线残留** / `Tooltip.lua:402-407`（InsertBlock 早退）、`373-381`（FinalizeBlock/ShowUnderline）、`274-276`（OnShow 钩子）
- 问题：`RefreshShownTooltips` 经 `SetHyperlink` 重放时，若新结果「谁都没有」→ `AddCountBlock` 返回 nil → `InsertBlock` 在 `if not lineIndexes then return end` 早退，不经过 `FinalizeBlock`，不调用 `HideUnderline`；而 OnShow 钩子仅在 `IsItemTooltip()==false`（非物品框）时才隐藏下划线，物品框恒不隐藏 → 上轮遗留的下划线纹理（`tooltip.__slUnderline`）保持显示。
- 证据：`Tooltip.lua:404` 早退 return；`:276` 仅非物品框隐藏。
- 建议：InsertBlock 早退分支补 `HideUnderline(tooltip)`，或在 `InvalidateAndRefresh` 重放前先隐藏。触发条件极窄（需「当前角色有 >0 且悬停中归零、提示框不关闭」），故定 P3。

**[P3] `bags` 负值 clamp 掩盖口径不一致信号** / `Tooltip.lua:39-41`
- 问题：`if bags < 0 then bags = 0 end` 把「装备数 > carried」这一 GetItemCount 与装备表口径不一致的唯一可观测信号静默吞掉，使 E2 类问题无从察觉。
- 建议：保留 clamp（防显示负数），可加一次性调试输出或注释说明该分支代表口径不一致。

**[P3] 装备表仅首次 `PLAYER_ENTERING_WORLD` 建一次** / `Core.lua:136-137`、`147`
- 问题：`if SL.player then return end` 使后续进入世界（换地图/进本，PLAYER_ENTERING_WORLD 会重复触发）不再重跑 `RebuildEquipped`；若首次进入时 `GetInventoryItemID` 因装备数据尚未就绪返回全 nil（理论时序），装备表将整场会话恒 0，且 PLAYER_EQUIPMENT_CHANGED 不会补发。
- 建议：早退前对「player 已存在但 equippedCounts 全空」做一次防御性重建。大概率非问题（装备数据在该事件时已就绪、此乃读装备的标准事件），故 P3。

## 3. 逐条裁决（E2/E3/E4/E5/E9）

**E2（衬衫槽4 / 战袍槽19）—— 无法确定**
- `RebuildEquipped` 遍历 INVSLOT 1..19（含 4=衬衫、19=战袍，F7）；`GetInventoryItemID` 为这两槽返回 itemID（wiki 确认）。风险仅在 F1「`GetItemCount` 1 参含已装备」是否覆盖这两类**装饰位**。
- 若 `GetItemCount` **不**统计它们：则「背 = carried − equipped」在「已装备且背包里还有同名备件」时**少算装备件数**（穿 1 件战袍 + 包 2 件同款 → carried=2、equipped=1、背=1，真值应 2）。「银」不受影响（all−carried 中装备天然抵消，`Tooltip.lua:29` 注释正确），「装备」列正确；仅装备无备件时背=0 仍正确（负值被 clamp）。
- **需要验证**：真机 `/dump C_Item.GetItemCount(<衬衫ID>)` 穿着时（无备件）是否为 ≥1，脱下后再 dump 对比是否 −1。这是唯一能定论的方式（F1 的戒指实测未覆盖衬衫/战袍）。
- 若验证为「不统计」：修法方向 = 装备扫描排除槽 4/19 作为减数，或对这两槽改按「背 = carried」不做减法。

**E3（换装时序）—— 证伪（低风险）**
- 事件到达时 `RebuildEquipped` 同步读 `GetInventoryItemID`，事件在装备已落槽后才发，读取即为新状态；全量重建 + 0.05s 去抖合并多槽连续事件（2H 换 MH+OH 时 offhand 先 `hasCurrent=false`、mainhand 后 `hasCurrent=true` 的瞬时窗），最终态正确、瞬时旧值下一次事件/下次悬停自愈。payload 被忽略是安全取舍。

**E4（and/or 布尔语义）—— 证伪**
- `SL.GetEquippedCount` 恒为函数（真值）；`SL:GetEquippedCount` 恒返回数字（`equippedCounts[id] or 0`）。0 在 Lua 为真值，不会被 `or 0` 吞掉；`and/or` 左支恒真、右支恒为数字，0 不会被误替换。

**E5（三值接收残留）—— 证伪**
- 全仓唯一调用点 `Tooltip.lua:59`：`local bags, bank, equipped = CurrentCounts(itemID)` 三值正确接收；grep 无其他调用、无二值接收残留。

**E9（all 回落路径）—— 证伪（自洽）**
- `all` 回落 = carried 时：bank = carried − carried = 0（无负数）；bags = carried − equipped（已 clamp ≥0）；bags+bank+equipped = carried，与 A4/A5/A6 自洽，仅「银」静默退化到 0（=旧行为），无怪值/无负数。

## 4. A 系列不变量核对（本镜头 A1–A10）

| 项 | 裁决 | 说明 |
|---|---|---|
| A1 背 = GetItemCount − 装备 | ✓ | 受 E2 衬衫/战袍不确定性制约 |
| A2 银 = all − base | ✓ | 装备在差值中天然抵消，不受 E2 影响；已 apidoc 复核 `C_Item.GetItemCount(itemInfo, includeBank, includeUses, includeReagentBank, includeAccountBank)`，第 2/4/5 参 true 正确 |
| A3 装备 = 每槽 +1 | ✓ | `RebuildEquipped` 命中即 +1 |
| A4 total 三值；他人背+银 | ✓ | 他人行无 equipped 字段，`RowDetail` 经 `(row.equipped or 0)>0` 正确跳过 |
| A5 行出现条件 | ✓ | 当前 `bags and (bags+bank+equipped)>0`（0 为真值故显式 >0，正确）；他人 `b+k>0` |
| A6 合计 = Σ total | ✓ | 当前含装备、他人不含（与 E1 不对称一致） |
| A7 装备表生命周期 | ✓ | 建表/重建/不入存档/双兜底（常量→1..19、API 缺→全 0）均实装 |
| A8 缓存失效三事件 + 0.05s 去抖 | ✓ | `EQUIPMENT_CHANGED` 由 Core 在 RebuildEquipped 后 Fire |
| A9 明细列规则 | ✓ | 背恒显示、银/装备仅 >0 追加 |
| A10 无调试接口 | ✓ | grep 全仓无 `SL.Tooltip` / `:CacheSize` / `:ClearCache` |
| A11 / A12 | 未核 | 装置保真 / 三语文档，非本镜头 |

**补充事实依据**：apidoc 12.1.0 确认 `C_Item.GetEquippedCount` / 全局 `GetEquippedCount` 不存在（F4）；`GetInventoryItemID` 为全局函数（wiki 12.1.5 活页，返回 `itemId[, unknown]`）；`PLAYER_EQUIPMENT_CHANGED` 载荷 `(equipmentSlot, hasCurrent)`；`ContainerItemInfo` 含 `itemID`/`stackCount` 字段（Scan.lua 用法正确）。
