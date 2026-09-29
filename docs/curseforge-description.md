**StockTake** answers one question the moment you hover an item: *how many of these do I actually own?*

Bags, bank (warband bank included), and every character on your account — right on the tooltip, in a clean block after the game's own description. **The screenshot in the project gallery shows exactly what it looks like.**

## What it does

Hover any item — bags, bank, auction house, chat links — and the counts appear on the tooltip, right below the game's own description: one row per character, then the total.

- Your current character is always the first row, with a red line under the name so you can find yourself at a glance.
- Character names are class-colored.
- The parentheses line up in a perfect column — no drift at 3, 12 or 170.
- `bank` already includes the **warband bank** — nothing double-counted, no mental math.
- The block sits after the game's own description and before other addons' lines (Auctionator's sell price and friends).

## Options

**ESC -> Options -> AddOns -> StockTake**, or just `/st`:

| Option | What it does |
|---|---|
| Show total line | Show or hide the `Total` row |
| Tooltip font size | Resizes the whole tooltip text; default "Follow game" changes nothing |
| Which characters to show | The one control for other characters: uncheck alts you no longer care about (uncheck everything to see only yourself); your current character always stays |

Extra slash commands: `/st en`, `/st zh`, `/st tw` (language), `/st auto` (follow the client), `/st clean [days]` (drop records of characters idle for N days, 30 by default).

## Details

- **Account-wide, zero setup.** Each character is recorded when you log in (bags) and when you open your bank.
- **No libraries, no network, no popups.** 5 Lua files, about 47 KB zipped.
- **What is stored:** item IDs and counts only — `WTF\Account\...\SavedVariables\StockTake.lua`. Delete that file with the game closed for a clean slate.
- **Coexists with everything.** By default it only adds its own lines to the tooltip; no scaling, no touching other addons' lines.
- **Three languages built in:** English, Simplified Chinese and Traditional Chinese, switched live with `/st en`, `/st zh`, `/st tw`.

## Install

Drop the `StockTake` folder into `World of Warcraft\_retail_\Interface\AddOns\` and `/reload`.

(The addon is listed in-game as **StockTake**.)

Requires World of Warcraft retail (Midnight).

---

# 数量盘点 StockTake

**悬停任意物品，立刻告诉你账号里一共有多少。** 背包、银行（含战团银行）、以及每个角色的持有量，直接显示在物品提示框上。**实际效果见项目图库里的截图。**

## 它做什么

悬停任何物品——背包、银行、拍卖行、聊天里的物品链接——数量会出现在提示框里，就在游戏自带说明的下方：每个角色一行，最后一行是合计。

- **当前角色永远在第一行**，名字下面有一条红线，一眼就能找到自己；
- 角色名按职业着色，和团队框架一个习惯；
- 括号里的背包/银行明细**对齐成整齐的一列**，3 位、12 位、170 位都不会漂；
- **`bank` 已经包含战团银行**——不重复计数，也不用自己心算；
- 数量块位于游戏自带说明之后、其他插件行（比如 Auctionator 的售价）之前，不用滚到提示框底部去找。

## 选项

**ESC → 选项 → 插件 → 数量盘点**，或者直接输入 `/st`：

| 选项 | 作用 |
|---|---|
| 显示总计行 | 控制那行 `Total: 42` |
| 提示框字号 | 调整整个提示框文字大小；默认"跟随游戏"等于不动它 |
| 显示哪些角色 | 控制"其他角色"的唯一开关：不想看的小号取消勾选即可，全部取消＝只看自己；当前角色永远保留 |

更多命令：`/st en`、`/st zh`、`/st tw` 切换语言，`/st auto` 跟随客户端；`/st clean [天数]` 清理超过 N 天没登录的角色记录（默认 30 天）。

## 细节

- **全账号、免配置。** 每个角色登录时记录背包，打开银行时记录银行。
- **不依赖任何库、不联网。** 5 个 Lua 文件，压缩后约 47 KB。
- **只记录物品 ID 与数量**，位置在 `WTF\Account\...\SavedVariables\StockTake.lua`；想彻底重来，关掉游戏删掉该文件即可。
- **不干扰其他插件**：默认只在提示框里增加自己的行，不缩放、不改动别人的行。
- **内置三种语言**：简体中文、繁体中文、英文，`/st zh`、`/st tw`、`/st en` 即时切换。

## 安装

把 `StockTake` 文件夹放进 `World of Warcraft\_retail_\Interface\AddOns\`，然后 `/reload`。
（游戏内插件列表显示为**数量盘点**。）

需要《魔兽世界》正式服（Midnight）。

---

# 數量盤點 StockTake

**滑鼠移到任何物品上，立刻告訴你整個帳號有多少。** 背包、銀行（含戰隊銀行）、以及每個角色的持有量，直接顯示在物品提示資訊上。**實際效果見專案圖庫裡的截圖。**

## 它做什麼

滑鼠移到任何物品上——背包、銀行、拍賣場、聊天裡的物品連結——數量會出現在提示資訊中，就在遊戲原生說明的下方：每個角色一列，最後一列是合計。

- **目前角色永遠在第一列**，名字下面有一條紅線，一眼就能找到自己；
- 角色名稱按**職業顏色**顯示，跟團隊框架一個習慣；
- 括號裡的背包／銀行明細**對齊成整齊的一欄**，3 位、12 位、170 位都不會歪；
- **`bank` 已經包含戰隊銀行**——不重複計算，也不用自己心算；
- 數量區塊位於遊戲原生說明之後、其他插件列（例如 Auctionator 的售價）之前，不用把提示資訊拉到最底才找到。

## 設定

**ESC → 選項 → 插件 → 數量盤點**，或者直接輸入 `/st`：

| 設定 | 作用 |
|---|---|
| 顯示合計列 | 控制那一列 `Total: 42` |
| 提示資訊字型大小 | 調整整份提示資訊的文字大小；預設「跟隨遊戲」等於不動它 |
| 顯示哪些角色 | 控制「其他角色」的唯一開關：不想看的分身取消勾選即可，全部取消＝只看自己；目前角色永遠保留 |

更多指令：`/st en`、`/st zh`、`/st tw` 切換語言，`/st auto` 跟隨客戶端；`/st clean [天數]` 清理超過 N 天未登入的角色紀錄（預設 30 天）。

## 細節

- **全帳號、免設定。** 每個角色登入時記錄背包，開啟銀行時記錄銀行。
- **不依賴任何函式庫、不連網。** 5 個 Lua 檔案，壓縮後約 47 KB。
- **只記錄物品 ID 與數量**，位置在 `WTF\Account\...\SavedVariables\StockTake.lua`；想徹底重來，關掉遊戲刪掉該檔案即可。
- **不干擾其他插件**：預設只在提示資訊中增加自己的列，不縮放、不改動別人的列。
- **內建三種語言**：簡體中文、繁體中文、英文，`/st zh`、`/st tw`、`/st en` 即時切換。

## 安裝

把 `StockTake` 資料夾放進 `World of Warcraft\_retail_\Interface\AddOns\`，然後 `/reload`。
（插件列表裡顯示為**數量盤點**。）

需要《魔獸世界》正式伺服器（Midnight）。
