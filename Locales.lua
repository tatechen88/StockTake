-- StockTake 简化版 · 词条（三语：简体中文 / 繁體中文 / English）
-- 三套表放在同一文件，无第三方库。
-- 由 GetLocale() 自动选择；也可以用 /st zh、/st tw、/st en、/st auto 临时切换以便预览。
-- 注意：zhTW 不是简体的字形转换，而是按繁体客户端的习惯用词撰写（字型／設定／帳號／戰隊銀行／列／登入／
-- 紀錄／記憶體／快取／預設／指令／訊息…），用词与繁体客户端保持一致。
local ADDON_NAME, SL = ...

local zhCN = {
    ADDON_TITLE       = "数量盘点",
    FONT_SIZE         = "提示框字体大小",
    FONT_SIZE_TIP     = "作用于整个提示框（包括游戏自带内容与其他插件添加的行）。拖到最左端 = 跟随游戏默认字号。",
    FOLLOW_GAME       = "跟随游戏",
    SHOW_TOTAL        = "显示合计行",
    SHOW_TOTAL_TIP    = "在所有角色行下方显示一行合计。",
    BAGS              = "背",
    BANK              = "银",
    TOTAL             = "合计",
    PAREN_LEFT        = "     （",  -- 视觉间距；括号对齐由固定像素列实现（AnchorDetailColumn）
    PAREN_RIGHT       = "）",
    HINT              = "命令：/st 打开设置 · /st tw 预览繁体 · /st en 预览英文",
    CHAR_SELECT       = "显示哪些角色",
    CHAR_SELECT_TIP   = "勾选的角色会出现在物品提示框里（这是控制其他角色的唯一开关：全部取消勾选＝只看自己）。当前角色始终显示，需要该角色登录过一次才有记录。",
    CHAR_SELF_NOTE    = "（当前角色，始终显示）",
    MSG_LOCALE_EN     = "已切换为英文（提示框与设置面板即时生效；左侧分类名下次重载同步）。输入 /st zh 切回简体中文。",
    MSG_LOCALE_ZH     = "已切换为简体中文（提示框与设置面板即时生效；左侧分类名下次重载同步）。",
    MSG_LOCALE_TW     = "已切换为繁体中文（提示框与设置面板即时生效；左侧分类名下次重载同步）。",
    MSG_LOCALE_AUTO   = "已恢复为跟随客户端语言（即时生效）。",
    MSG_LOCALE_BAD    = "无法保存语言设置。",
    CLEAN_DONE        = "清理完成：移除 %d 个超过 %d 天未登录的角色，剩余 %d 个角色 / %d 条物品记录。",
}

-- 繁體中文：用語按繁體魔獸世界客戶端習慣，非簡繁直轉
local zhTW = {
    ADDON_TITLE       = "數量盤點",
    FONT_SIZE         = "提示資訊字型大小",
    FONT_SIZE_TIP     = "套用到整份提示資訊（包含遊戲自帶內容與其他插件新增的列）。拖到最左邊 = 跟隨遊戲預設字型大小。",
    FOLLOW_GAME       = "跟隨遊戲",
    SHOW_TOTAL        = "顯示合計列",
    SHOW_TOTAL_TIP    = "在所有角色列下方顯示一列合計。",
    BAGS              = "背",
    BANK              = "銀",
    TOTAL             = "合計",
    PAREN_LEFT        = "     （",  -- 視覺間距；括號對齊由固定像素欄位實現（AnchorDetailColumn）
    PAREN_RIGHT       = "）",
    HINT              = "指令：/st 開啟設定 · /st zh 預覽簡體 · /st en 預覽英文",
    CHAR_SELECT       = "顯示哪些角色",
    CHAR_SELECT_TIP   = "勾選的角色會出現在物品提示資訊中（這是控制其他角色的唯一開關：全部取消勾選＝只看自己）。目前角色一律顯示，該角色需登入過一次才會有紀錄。",
    CHAR_SELF_NOTE    = "（目前角色，一律顯示）",
    MSG_LOCALE_EN     = "已切換為英文（提示資訊與設定面板即時生效；左側分類名稱下次重新載入時同步）。輸入 /st tw 切回繁體中文。",
    MSG_LOCALE_ZH     = "已切換為簡體中文（提示資訊與設定面板即時生效；左側分類名稱下次重新載入時同步）。",
    MSG_LOCALE_TW     = "已切換為繁體中文（提示資訊與設定面板即時生效；左側分類名稱下次重新載入時同步）。",
    MSG_LOCALE_AUTO   = "已恢復為跟隨客戶端語言（即時生效）。",
    MSG_LOCALE_BAD    = "無法儲存語言設定。",
    CLEAN_DONE        = "清理完成：移除 %d 個超過 %d 天未登入的角色，剩餘 %d 個角色 / %d 筆物品紀錄。",
}

local enUS = {
    ADDON_TITLE       = "StockTake",
    FONT_SIZE         = "Tooltip font size",
    FONT_SIZE_TIP     = "Applies to the whole tooltip, including the game's own lines and other addons' lines. Slide to the far left = follow the game default.",
    FOLLOW_GAME       = "Follow game",
    SHOW_TOTAL        = "Show total line",
    SHOW_TOTAL_TIP    = "Show a total line below all character lines.",
    BAGS              = "bags",
    BANK              = "bank",
    TOTAL             = "Total",
    PAREN_LEFT        = "     (",   -- visual gap; alignment comes from the fixed pixel column (AnchorDetailColumn)
    PAREN_RIGHT       = ")",
    HINT              = "Command: /st for settings · /st zh simplified · /st tw traditional",
    CHAR_SELECT       = "Which characters to show",
    CHAR_SELECT_TIP   = "Checked characters appear on item tooltips (this list is the only control for other characters: uncheck everything to see just yourself). Your current character is always shown; a character needs to log in once to be recorded.",
    CHAR_SELF_NOTE    = " (current character, always shown)",
    MSG_LOCALE_EN     = "Switched to English (tooltip and options panel update instantly; the sidebar category name follows on the next reload). Type /st zh for Chinese.",
    MSG_LOCALE_ZH     = "Switched to Simplified Chinese (tooltip and options panel update instantly; the sidebar category name follows on the next reload). Type /st tw for Traditional Chinese.",
    MSG_LOCALE_TW     = "Switched to Traditional Chinese (tooltip and options panel update instantly; the sidebar category name follows on the next reload). Type /st en for English.",
    MSG_LOCALE_AUTO   = "Locale now follows the client again (applies instantly).",
    MSG_LOCALE_BAD    = "Could not save the locale setting.",
    CLEAN_DONE        = "Cleanup done: removed %d characters not seen for over %d days; %d characters / %d item records remain.",
}

SL.localeTables = { zhCN = zhCN, zhTW = zhTW, enUS = enUS }

-- 当前生效的语言：options.locale 为 "zhCN"/"zhTW"/"enUS" 时强制使用，否则跟随客户端
function SL:CurrentLocale()
    local db = SL2_DB
    local override = type(db) == "table" and type(db.options) == "table" and db.options.locale
    if override == "zhCN" or override == "zhTW" or override == "enUS" then return override end
    if type(GetLocale) == "function" then
        local client = GetLocale()
        if client == "zhCN" then return "zhCN" end
        -- 繁體客戶端：retail 只有 zhTW；防禦性兼容 zhHK 之類的繁體變體（若有）
        if client == "zhTW" or client == "zhHK" then return "zhTW" end
    end
    return "enUS"
end

-- SL.L 是一个代理：每次取值都按"当前语言"解析，
-- 因此 /st en 之后提示框立刻变英文，无需重启或 /reload。
-- ⚠ 注意：代理表本身为空，pairs(SL.L) 遍历不出任何键 ——
--    需要枚举词条时请用 SL.localeTables.zhCN / zhTW / enUS（测试即如此）。
SL.L = setmetatable({}, {
    __index = function(_, key)
        local table_ = SL.localeTables[SL:CurrentLocale()] or enUS
        return table_[key]
    end,
})
