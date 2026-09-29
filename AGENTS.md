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
node tools/api-audit.js .     # 本项目历史踩过的弃用 / 不存在 API（规则表）
node tools/simple-smoke.js    # 无头冒烟测试（fengari VM + 自建 API 模拟层）
node tools/check-zhtw.js      # 繁体文案里混进简体字
```

第 5 道关卡（与**官方 apidoc** 对表，抓"引用了不存在的 API"最有效）：

```powershell
python <apidoc镜像>\check_project_api.py Core.lua Scan.lua Tooltip.lua Options.lua Locales.lua
# 期望：发现问题 = 0
```

apidoc 镜像的取法：从 Gethe/wow-ui-source 上**与本机客户端 build 对应**的 tag，取
`Interface/AddOns/Blizzard_APIDocumentationGenerated`（暴雪随客户端发布的生成式 API 定义，一手权威）。
镜像放在插件目录之外，别拷进仓库。`check_project_api.py` 是项目无关的，直接传上面的 lua 文件即可。

首次使用先装依赖：`npm --prefix tools install`

## 硬性规则

1. **三语文案必须同改**：`README{,.en,.zhTW}.md`、`CHANGELOG{,.en,.zhTW}.md`、`Locales.lua` 的三张表、`.toc` 的 `Title-*` / `Notes-*`。加新语言时最容易漏的是**旧语言的主文档**（简体 / 英文 README 的语言行）。
2. **语言只称「简体中文 / 繁體中文 / English」**，不出现任何地区性字样。
3. **Lua 与 .toc 用 LF 行尾、UTF-8 无 BOM**（`.gitattributes` 已固定行尾）。
4. **默认值必须"不干预"**：任何全局生效的设置，默认值都要让它装上等于没装。
5. **改 API 前先实核**：以官方 apidoc（对应客户端 build）为准，别信记忆与二手转述。注意 apidoc **不收录老式全局函数**（如 `GetInventoryItemID`），"apidoc 里没有"不能单独定罪一个 API 不存在——需要 wiki 或游戏内 `/dump` 交叉。
6. **测试装置不得提供真机不存在的 API 与枚举成员**。装置造出来的假 API 会让"失效的修复"在满绿测试下长期潜伏（0.9.4→0.9.6 的 `GetEquippedCount` 就是这么藏了三个版本）。mocks 里的每个桩都应能指出它在真机上的对应物。

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
- **给人跑 `/run` 诊断命令有三条硬约束**（都踩过）：① 聊天输入框上限 **255 字符**，超了直接发不出去；
  ② WoW **默认不显示 Lua 错误**（`/console scriptErrors 1` 才开），所以命令一旦报错，用户看到的就是
  **"什么都没发生"**；③ 因此命令必须**自带可见输出**——连失败分支也要 `print`（例如"没找到物品"），
  并且不要写"待用户替换"的中文占位符（用户照原样粘贴会得到 nil → 又变成静默失败）。
  给命令前先在测试装置里跑一遍：能否编译、是否有输出、长度多少。
- **对照实验要选"无论物品放哪都成立"的判据**：判断某个计数 API 含不含某类容器时，别依赖
  "用户会把物品只放在那一处"这种无法验证的前提——同一物品同时存在于多处是常态。
  做法是把整个背包逐槽扫一遍得到实际总数，再与 API 读数对表。
