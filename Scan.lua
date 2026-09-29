-- StockTake 简化版 · 扫描
-- 只记录「其他角色」需要的数字：背包 + 该角色自己的银行（归为一个数字）。
-- 当前角色的数字不靠本文件 —— Tooltip.lua 直接问游戏 API，永远实时准确。
local ADDON_NAME, SL = ...

SL.Scan = {}
local Scan = SL.Scan

local function NumSlots(bagID)
    local C = C_Container
    if not (C and C.GetContainerNumSlots) then return 0 end
    local n = C.GetContainerNumSlots(bagID)
    if type(n) ~= "number" then return 0 end
    return n
end

-- 把一个容器的堆叠数累加进 counts；返回可读槽位数（0 = 容器不存在/未加载）
local function AddContainer(counts, bagID)
    local slots = NumSlots(bagID)
    if slots == 0 then return 0 end
    local C = C_Container
    for slot = 1, slots do
        local info = C.GetContainerItemInfo(bagID, slot)
        if info and info.itemID then
            counts[info.itemID] = (counts[info.itemID] or 0) + (info.stackCount or 1)
        end
    end
    return slots
end

-- 背包容器：用 Enum.BagIndex 命名成员（0=背包、1-4=普通包、5=材料包），缺失时回落数字
local function BagIDs()
    local B = (Enum and Enum.BagIndex) or {}
    local named = { B.Backpack, B.Bag_1, B.Bag_2, B.Bag_3, B.Bag_4, B.ReagentBag }
    local ids = {}
    for i = 1, #named do
        if type(named[i]) == "number" then ids[#ids + 1] = named[i] end
    end
    if #ids == 0 then ids = { 0, 1, 2, 3, 4, 5 } end
    return ids
end

-- 角色银行：已购银行页（动态枚举）。
-- 12.x 的银行结构 = 6 个角色银行页 + 5 个账号银行页，**没有独立的"银行包栏"容器**：
-- Enum.BagIndex 的 20 个成员里没有 BankBag（11.2.7 起就没有），旧写法 `B.BankBag`
-- 是从更早版本抄来的死代码，因外层有 type() 判断而一直静默跳过，0.9.7 清除。
-- 账号银行不在这里扫 —— 它与其他角色共享，由当前角色经 GetItemCount(includeAccountBank)
-- 计入「银」，避免同一批物品被重复计数。
local function BankIDs()
    local ids = {}
    local C_Bank = C_Bank
    if C_Bank and C_Bank.FetchPurchasedBankTabIDs and Enum and Enum.BankType then
        local ok, list = pcall(C_Bank.FetchPurchasedBankTabIDs, Enum.BankType.Character)
        if ok and type(list) == "table" then
            for i = 1, #list do
                if type(list[i]) == "number" then ids[#ids + 1] = list[i] end
            end
        end
    end
    return ids
end

-- 返回 counts 与"读到内容的容器数"
local function Collect(ids)
    local counts, readable = {}, 0
    for i = 1, #ids do
        if AddContainer(counts, ids[i]) > 0 then readable = readable + 1 end
    end
    return counts, readable
end

local function SaveCounts(source, counts)
    local player = SL.player
    if not player then return end
    local rec = SL:CharRecord(player.key)
    if not rec then return end
    rec.name     = player.name
    rec.class    = player.class
    rec.lastSeen = time()                   -- v0.9.2：供 /st clean 判断弃用角色
    rec[source]  = counts
    SL:Fire("DATA_CHANGED")
end

-- 审计 A2（银行侧加固）：银行页与银行包栏的槽位数是**固定**的（买了就有槽），
-- 因此"可读容器数 < 期望容器数"只可能意味着容器数据还没加载完 —— 此时跳过写入、
-- 保留上一轮完整快照，避免半截数据抹掉长期积累的银行记录。
-- 背包侧**不**用这条判据：空着的包位/材料包位本来就返回 0 槽，若严格要求全部可读，
-- 没把包槽装满的玩家将永远无法保存背包数据；且 BAG_UPDATE_DELAYED 本身就是
-- "背包数据已就绪"的合并信号，部分可读在这里不构成可信的异常。
--
-- 0.9.4 加固（条件性风险的补丁）：槽位数 > 0 只证明"容器在"，**不证明物品读得到**
-- ——空槽与"物品数据未就绪"都会让 GetContainerItemInfo 返回 nil，两者无法区分。
-- 于是再加一条有界复核：若本次读到空、而手里已有非空银行快照，先不覆盖，
-- 0.5s 后复核一次；复核仍为空才落地（用户真的清空银行时照样能正确写入）。
local function CountsHasAny(counts)
    for _ in pairs(counts) do return true end
    return false
end

local bankRechecking = false

local function CommitBank(counts)
    local player = SL.player
    local rec = player and SL2_DB and type(SL2_DB) == "table" and SL2_DB.chars and SL2_DB.chars[player.key]
    local hadItems = type(rec) == "table" and type(rec.bank) == "table" and CountsHasAny(rec.bank)
    if not CountsHasAny(counts) and hadItems and not bankRechecking then
        bankRechecking = true
        SL:Debounce("bankRecheck", 0.5, function()
            bankRechecking = false
            Scan:Bank(true)                       -- 复核扫描：结果直接落地
        end)
        return
    end
    SaveCounts("bank", counts)
end

function Scan:Bags()
    local counts, readable = Collect(BagIDs())
    if readable == 0 then return end             -- 完全不可读（数据未加载）→ 保留上轮数据
    SaveCounts("bags", counts)
end

-- verified = true 表示这是"疑似空"之后的复核扫描：即使是空也直接落地，
-- 不会再排下一次复核（否则空银行会陷入无限推迟）。
function Scan:Bank(verified)
    local ids = BankIDs()
    if #ids == 0 then return end
    local counts, readable = Collect(ids)
    if readable < #ids then return end           -- 有页没读到 → 半截数据，保留上一轮
    if verified then
        SaveCounts("bank", counts)
    else
        CommitBank(counts)
    end
end

-- ── 事件（背包变化 / 银行开与关） ──────────────────────────────────
-- 0.9.4 修复：BANKFRAME_OPENED 只在"打开那一刻"发一次；之后在银行里存/取/整理
-- 只会发 BAG_UPDATE(_DELAYED)（Blizzard 自家银行面板即以 BAG_UPDATE 刷新，
-- 见 BankFrame.lua 的 BankPanelEvents；PLAYERBANKSLOTS_CHANGED 明确不含银行包
-- 的物品增减）。旧代码在 BAG_UPDATE_DELAYED 里只重扫背包，导致银行快照一直
-- 停在开行那一刻的数字。现在：银行打开期间，背包变化会一并重扫银行。
local frame = SL.frame
frame:RegisterEvent("BAG_UPDATE_DELAYED")
frame:RegisterEvent("BANKFRAME_OPENED")
frame:RegisterEvent("BANKFRAME_CLOSED")

local bankOpen = false

function SL:BAG_UPDATE_DELAYED()
    if not SL.player then return end
    SL:Debounce("bags", 0.2, function() Scan:Bags() end)
    if bankOpen then
        -- 银行开着：这次背包变化可能就是一次银行存取，重扫银行（沿用整快照守卫）
        SL:Debounce("bank", 0.3, function() Scan:Bank() end)
    end
end

function SL:BANKFRAME_OPENED()
    if not SL.player then return end
    bankOpen = true
    SL:Debounce("bank", 0.5, function() Scan:Bank() end)
end

function SL:BANKFRAME_CLOSED()
    -- 该事件会连发两次，且只有第一次时银行数据仍可读；这里只清标志，不做任何扫描。
    bankOpen = false
end
