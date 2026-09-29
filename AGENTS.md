# StockTake — 项目约定

WoW 插件：把全账号的物品数量显示在物品提示框上。

## 目录结构

本仓库**根目录就是插件本体**（`StockTake.toc` 与 5 个 Lua 在根层）——仓库名 = 插件文件夹名，与打包约定一致。

| 位置 | 说明 |
|---|---|
| 仓库根 | 插件运行文件 + 三语 README / CHANGELOG + `LICENSE.txt` |
| `Media/` | 插件列表图标（`.tga`），随包发布 |
| `tools/` | 语法检查、弃用 API 审计、无头冒烟测试、打包与上传脚本 |
| `docs/` | 公开文档：审计报告、打码后的截图、CurseForge 三语描述 |
| `.scratch/` | 一次性 / 本机专用脚本（git 忽略，只保留 `.gitkeep`） |

游戏内的运行副本在 `World of Warcraft\_retail_\Interface\AddOns\StockTake`。**仓库是事实源**，改完需要同步运行文件过去（游戏只加载 `.toc` 列出的文件，但运行副本保持精简最省心）。

## 关卡（提交前跑）

```powershell
node tools/lua-check.js .     # Lua 语法
node tools/api-audit.js .     # 弃用 / 不存在的 WoW API
node tools/simple-smoke.js    # 无头冒烟测试（fengari VM + 自建 API 模拟层）
node tools/check-zhtw.js      # 繁体文案里混进简体字
```

首次使用先装依赖：`npm --prefix tools install`

## 硬性规则

1. **三语文案必须同改**：`README{,.en,.zhTW}.md`、`CHANGELOG{,.en,.zhTW}.md`、`Locales.lua` 的三张表、`.toc` 的 `Title-*` / `Notes-*`。加新语言时最容易漏的是**旧语言的主文档**（简体 / 英文 README 的语言行）。
2. **语言只称「简体中文 / 繁體中文 / English」**，不出现任何地区性字样。
3. **Lua 与 .toc 用 LF 行尾、UTF-8 无 BOM**（`.gitattributes` 已固定行尾）。
4. **默认值必须"不干预"**：任何全局生效的设置，默认值都要让它装上等于没装。
5. **改 API 前先实核**：以游戏 `_retail_` 源码 / 官方文档为准，别信记忆与 wiki 转述。

## 命名与标识（改名时留意）

| 项 | 值 | 说明 |
|---|---|---|
| 文件夹名 | `StockTake` | 决定 SavedVariables 文件名，改了老记录不再被读取 |
| 存档变量 | `SL2_DB` | 改名会丢数据 |
| 斜杠命令 | `/st`、`/stocktake` | |
| CurseForge | 项目 ID `1714499`，slug `stocktake` | |

## 发布

```powershell
pwsh tools/build-release.ps1                              # → dist/StockTake-<version>.zip
pwsh tools/upload-to-curseforge.ps1 -ProjectId 1714499    # token 走环境变量 CF_API_TOKEN
```

`build-release.ps1` 会校验 `.toc` 引用齐全、`.toc` 名 == 文件夹名、`IconTexture` 资产存在，并回读 zip 条目。

## 已知坑（都踩过）

- `GameTooltip:AddLine()` 的**返回值不可靠**——取 FontString 必须按 `TextLeftN` 行号兜底，否则只有第一行生效。
- `SettingsCheckboxTemplate` **本身没有文本元素**；对它 `SetText` 会造出没有锚点的 FontString——API 读回能过，字却看不见。勾选框标签要自建 FontString 并显式锚定。
- 行号可能是浮点数（`1.0 .. "" == "1.0"`）——构造控件名一律 `string.format("%d", math.floor(i))`。
- 设置面板的构建要挂在**登录事件**上，不要挂在斜杠命令里：玩家经 ESC → 选项 → 插件 打开面板不会走命令入口。
- 先写日志、后改文案时，**日志会漏掉后加的语言**——三语化之后任何文案变动都要三份同改。
