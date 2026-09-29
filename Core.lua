-- StockTake 简化版 · Core
-- 职责：命名空间 / SavedVariables / 配置读写 / 事件分发 / 去抖
local ADDON_NAME, SL = ...

SL.ADDON_NAME = ADDON_NAME
SL.DB_VERSION = 2
SL.player = nil                      -- { name, realm, key, class }

local DEFAULTS = {
    fontSize   = 0,        -- 0 = 跟随游戏（不干预提示框字体）；>0 = 全局字号
    showTotal  = true,
    locale     = nil,      -- nil = 跟随客户端语言；"zhCN"/"enUS" = 预览用强制语言
}
SL.DEFAULTS = DEFAULTS

local function ReportError(err)
    if type(geterrorhandler) == "function" then geterrorhandler()(err) end
end

-- ── 配置 ────────────────────────────────────────────────────────────
function SL:Get(key)
    local db = SL2_DB
    if type(db) == "table" and type(db.options) == "table" and db.options[key] ~= nil then
        return db.options[key]
    end
    return DEFAULTS[key]
end

function SL:Set(key, value)
    if type(SL2_DB) ~= "table" or type(SL2_DB.options) ~= "table" then return end
    SL2_DB.options[key] = value
    SL:Fire("CONFIG_CHANGED", key, value)
end

-- ── 内部事件（极简订阅） ────────────────────────────────────────────
local subs = {}

function SL:Fire(key, ...)
    local list = subs[key]
    if not list then return end
    for i = 1, #list do
        local ok, err = pcall(list[i], ...)
        if not ok then ReportError(err) end
    end
end

function SL:Subscribe(key, fn)
    local list = subs[key]
    if not list then
        list = {}
        subs[key] = list
    end
    list[#list + 1] = fn
end

-- ── 去抖（合并短时间内的重复事件） ──────────────────────────────────
local timers = {}

function SL:Debounce(key, delay, fn)
    local t = timers[key]
    if t then t:Cancel() end
    timers[key] = C_Timer.NewTimer(delay, function()
        timers[key] = nil
        fn()
    end)
end

-- ── 装备计数（内存，不入存档）───────────────────────────────────────
-- 为什么需要：C_Item.GetItemCount 的**基准计数包含已装备**件数，而「背」的口径不含已装备，
-- 必须把这个数减掉。而 12.1 并没有"直接给已装备件数"的 API —— C_Item.GetEquippedCount 在
-- 12.1.0 / 12.0.7 / 11.2.7 的官方 apidoc 里都不存在，社区 wiki 也从无此页面。
-- （0.9.4 曾按它写过一版减装备逻辑，因 API 不存在而静默失效，0.9.7 修正。）
-- 唯一可靠路径：遍历装备槽自己数。装备槽无堆叠语义，命中即 +1。
SL.equippedCounts = {}

local INV_FIRST_FALLBACK, INV_LAST_FALLBACK = 1, 19   -- FrameXML 常量取不到时的兜底

function SL:RebuildEquipped()
    local counts = SL.equippedCounts
    for k in pairs(counts) do counts[k] = nil end
    if type(GetInventoryItemID) ~= "function" then return end   -- 防御：拿不到就维持 0（等同旧行为）
    local first = tonumber(_G.INVSLOT_FIRST_EQUIPPED) or INV_FIRST_FALLBACK
    local last  = tonumber(_G.INVSLOT_LAST_EQUIPPED) or INV_LAST_FALLBACK
    for slot = first, last do
        local ok, id = pcall(GetInventoryItemID, "player", slot)
        if ok and type(id) == "number" then
            counts[id] = (counts[id] or 0) + 1
        end
    end
end

function SL:GetEquippedCount(itemID)
    if type(itemID) ~= "number" then return 0 end
    return SL.equippedCounts[itemID] or 0
end

-- 换装：重建装备表并通知。事件载荷 (equipmentSlot, hasCurrent) 用不上 ——
-- 全量重建 19 个槽的代价可忽略，省掉一个增量状态机。
function SL:PLAYER_EQUIPMENT_CHANGED()
    SL:RebuildEquipped()
    SL:Fire("EQUIPMENT_CHANGED")
end

-- ── 生命周期 ────────────────────────────────────────────────────────
local frame = CreateFrame("Frame")
SL.frame = frame
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("PLAYER_EQUIPMENT_CHANGED")

frame:SetScript("OnEvent", function(_, event, ...)
    local handler = SL[event]
    if type(handler) ~= "function" then return end
    local ok, err = pcall(handler, SL, ...)
    if not ok then ReportError(err) end
end)

function SL:ADDON_LOADED(name)
    if name ~= ADDON_NAME then return end
    if type(SL2_DB) ~= "table" then SL2_DB = {} end
    local db = SL2_DB
    db.version = SL.DB_VERSION
    if type(db.chars) ~= "table" then db.chars = {} end
    if type(db.options) ~= "table" then db.options = {} end
    for key, value in pairs(DEFAULTS) do
        if db.options[key] == nil then db.options[key] = value end
    end
    -- 0.9.4 迁移：showOthers 与「显示哪些角色」勾选列表功能重复，已移除该开关。
    -- 老存档里的键直接删掉，避免留下一个"看起来还能用、实际无人读取"的配置项。
    db.options.showOthers = nil
    -- 存档已就绪：Options.lua 在这里才构建面板（文件加载期读不到 SL2_DB，
    -- 会让面板语言停留在客户端语言、滑条初值也只能取默认值）
    SL:Fire("DB_READY")
end

function SL:PLAYER_ENTERING_WORLD()
    if SL.player then return end
    local name, realm = UnitFullName("player")
    if not name then return end
    realm = (realm or ""):gsub("%s+", "")
    SL.player = {
        name  = name,
        realm = realm,
        key   = realm .. "-" .. name,
        class = select(2, UnitClass("player")),
    }
    SL:RebuildEquipped()          -- 装备表要在第一次悬停之前就绪（否则「背」会含已装备）
    -- 登录时只记录背包；银行等打开银行界面时再记录
    if SL.Scan then SL.Scan:Bags() end
    SL:Fire("PLAYER_READY")
end

-- ── 角色数据 ────────────────────────────────────────────────────────
function SL:CharRecord(key)
    if type(SL2_DB) ~= "table" or type(SL2_DB.chars) ~= "table" or not key then return nil end
    local rec = SL2_DB.chars[key]
    if type(rec) ~= "table" then
        rec = { bags = {}, bank = {} }
        SL2_DB.chars[key] = rec
    end
    if type(rec.bags) ~= "table" then rec.bags = {} end
    if type(rec.bank) ~= "table" then rec.bank = {} end
    return rec
end

-- ── 角色显示筛选 ────────────────────────────────────────────────────
-- hiddenChars[key] = true 表示该角色不出现在提示框里；当前角色不受此影响（恒显示）。
function SL:IsCharHidden(key)
    local db = SL2_DB
    local hidden = type(db) == "table" and type(db.options) == "table" and db.options.hiddenChars
    return type(hidden) == "table" and hidden[key] == true or false
end

function SL:SetCharHidden(key, hidden)
    if type(SL2_DB) ~= "table" or type(SL2_DB.options) ~= "table" or not key then return end
    if type(SL2_DB.options.hiddenChars) ~= "table" then SL2_DB.options.hiddenChars = {} end
    if hidden then
        SL2_DB.options.hiddenChars[key] = true
    else
        SL2_DB.options.hiddenChars[key] = nil
    end
    SL:Fire("CONFIG_CHANGED", "hiddenChars", key)
end

-- ── 弃用角色清理（v0.9.2 内存瘦身）─────────────────────────────────
-- 删除"上次记录时间"早于 cutoff 的角色；没有 lastSeen 的旧记录**保留**
--（该角色下次登录会补上时间戳，之后即可被清理）——宁可保守，不误删。
-- 返回：移除数、剩余角色数、剩余物品条目总数
function SL:CleanOldChars(days)
    days = tonumber(days) or 30
    if days < 1 then days = 1 end
    local cutoff = time() - days * 86400
    if type(SL2_DB) ~= "table" or type(SL2_DB.chars) ~= "table" then return 0, 0, 0 end

    local selfKey = SL.player and SL.player.key
    local removed, kept, entries = 0, 0, 0
    for key, rec in pairs(SL2_DB.chars) do
        local isSelf = (key == selfKey)
        local seen = (type(rec) == "table") and tonumber(rec.lastSeen) or nil
        if not isSelf and seen ~= nil and seen < cutoff then
            SL2_DB.chars[key] = nil
            removed = removed + 1
        else
            kept = kept + 1
            if type(rec) == "table" then
                if type(rec.bags) == "table" then
                    for _ in pairs(rec.bags) do entries = entries + 1 end
                end
                if type(rec.bank) == "table" then
                    for _ in pairs(rec.bank) do entries = entries + 1 end
                end
            end
        end
    end
    if removed > 0 then SL:Fire("DATA_CHANGED") end
    return removed, kept, entries
end

-- ── 斜杠命令兜底（Options.lua 会覆盖为打开设置） ────────────────────
if type(SlashCmdList) == "table" then
    SLASH_STOCKTAKE1 = "/st"
    SLASH_STOCKTAKE2 = "/stocktake"
end
