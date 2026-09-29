-- StockTake 简化版 · 提示框
-- 当前角色：直接用 C_Item.GetItemCount 问游戏（第 5 参包含战团银行，无需自己扫）
-- 其他角色：读 SL2_DB（由 Scan.lua 记录）
local ADDON_NAME, SL = ...

SL.Tooltip = {}
local Tooltip = SL.Tooltip

-- 悬停结果缓存：**有上限的 FIFO**（v0.9.2 内存瘦身）。
-- 此前无上限——一场长会话里每看过一个物品就留一份行数据，只增不减。
local CACHE_MAX = 128
local cache = {}                            -- itemID -> rows
local cacheFifo = {}                        -- 插入顺序（淘汰最旧）

local function ClearCache()
    for key in pairs(cache) do cache[key] = nil end
    for i = #cacheFifo, 1, -1 do cacheFifo[i] = nil end
end

local function CachePut(itemID, rows)
    if cache[itemID] ~= nil then return end
    cache[itemID] = rows
    cacheFifo[#cacheFifo + 1] = itemID
    if #cacheFifo > CACHE_MAX then
        local oldest = table.remove(cacheFifo, 1)
        cache[oldest] = nil
    end
end

-- 当前角色的背包 / 银行（银行含战团银行）
-- 口径：GetItemCount 的 1 参基准计数**包含已装备**件数，而「背」不含已装备，故减去装备数；
-- 银行差值 (all − carried) 里装备数天然抵消，不受影响。
-- 0.9.7 修正：减数改为读 Core 的装备表（遍历装备槽自数）。0.9.4 曾用 C_Item.GetEquippedCount，
-- 但 12.1 根本没有这个 API（官方 apidoc 三个版本 + wiki 双源确认），那段修复从未生效过。
local function CurrentCounts(itemID)
    local getCount = C_Item and C_Item.GetItemCount
    if type(getCount) ~= "function" then return nil end

    local okBags, carried = pcall(getCount, itemID)
    if not okBags or type(carried) ~= "number" then return nil end

    local equipped = SL.GetEquippedCount and SL:GetEquippedCount(itemID) or 0
    local bags = carried - equipped
    if bags < 0 then bags = 0 end

    -- includeBank=true, includeUses=false, includeReagentBank=true, includeAccountBank=true
    local okAll, all = pcall(getCount, itemID, true, false, true, true)
    if not okAll or type(all) ~= "number" then all = carried end

    local bank = all - carried
    if bank < 0 then bank = 0 end
    -- 装备单独返回：它既不算「背」也不算「银」，但必须**能被看见** ——
    -- 否则"身上只有这一件"的物品会被算成一件都没有，整块从提示框上消失。
    return bags, bank, equipped
end

local function BuildRows(itemID)
    local rows = {}
    local player = SL.player
    if not player then return rows end

    local bags, bank, equipped = CurrentCounts(itemID)
    equipped = equipped or 0
    -- 一件都没有时不占位（0 在 Lua 里是真值，必须显式判断）。
    -- 装备同样算"有"：只戴着、没有备件时这一行也必须出现，
    -- 否则玩家悬停自己身上的装备会看到"什么都没有"。
    if bags and (bags + bank + equipped) > 0 then
        rows[#rows + 1] = {
            name = player.name, class = player.class,
            bags = bags, bank = bank, equipped = equipped,
            total = bags + bank + equipped, isPlayer = true,
        }
    end

    -- 其他角色：是否出现只由「显示哪些角色」逐角色勾选控制（0.9.4 起，
    -- 与它功能重复的全局开关 showOthers 已移除；全部取消勾选即等于只看自己）
    if type(SL2_DB) == "table" and type(SL2_DB.chars) == "table" then
        for key, rec in pairs(SL2_DB.chars) do
            if key ~= player.key and type(rec) == "table" and not SL:IsCharHidden(key) then
                local b = (type(rec.bags) == "table" and rec.bags[itemID]) or 0
                local k = (type(rec.bank) == "table" and rec.bank[itemID]) or 0
                if b + k > 0 then
                    rows[#rows + 1] = {
                        name = rec.name or key, class = rec.class,
                        bags = b, bank = k, total = b + k,
                    }
                end
            end
        end
    end

    -- 当前角色置顶，其余按总数降序，同数按名字
    table.sort(rows, function(a, b)
        if a.isPlayer ~= b.isPlayer then return a.isPlayer end
        if a.total ~= b.total then return a.total > b.total end
        return tostring(a.name) < tostring(b.name)
    end)
    return rows
end

-- 数量显示：统一按整数输出（避免任何小数残留，也让各语言客户端显示一致）
local function Num(value)
    return string.format("%d", math.floor((tonumber(value) or 0) + 0.5))
end

-- 名称部分（不带颜色码，用于量宽度）
local function PlainPrefix(row)
    return tostring(row.name or "?") .. ": " .. Num(row.total)
end

-- 左列：职业色名字 + 总数
local function RowPrefix(row)
    local name = tostring(row.name or "?")
    local color = RAID_CLASS_COLORS and row.class and RAID_CLASS_COLORS[row.class]
    if color and color.colorStr then
        name = "|c" .. color.colorStr .. name .. "|r"
    end
    return name .. ": " .. Num(row.total)
end

-- 右列：明细（括号前导空格保留在文案里，视觉间距与此前一致）
local function RowDetail(row)
    local L = SL.L
    local detail = L.BAGS .. " " .. Num(row.bags)
    if row.bank > 0 then
        detail = detail .. " · " .. L.BANK .. " " .. Num(row.bank)
    end
    -- 装备只在 > 0 时出现（与「银」同一惯例）。其他角色的记录里没有装备数据，自然不会显示。
    if (row.equipped or 0) > 0 then
        detail = detail .. " · " .. L.EQUIPPED .. " " .. Num(row.equipped)
    end
    return L.PAREN_LEFT .. detail .. L.PAREN_RIGHT
end

-- ── 字号：作用于**整个提示框**（含游戏自带内容与其他插件添加的行） ────
local FONT_MIN, FONT_MAX = 6, 32

-- 配置值 <= 0 表示"跟随游戏"（不干预任何字体）；默认即此，装上一无所改
local function ConfiguredSize()
    local size = tonumber(SL:Get("fontSize")) or 0
    if size <= 0 then return nil end
    if size < FONT_MIN then size = FONT_MIN elseif size > FONT_MAX then size = FONT_MAX end
    return size
end

local function GameFontPath()
    if GameFontNormal and GameFontNormal.GetFont then
        local ok, path = pcall(GameFontNormal.GetFont, GameFontNormal)
        if ok then return path end
    end
end

-- 被我们改过字号的行 → 原始字体（path/height/flags）。弱键表：FontString 回收后自动释放。
-- 0.9.4 修复：此前"跟随游戏"只是停止新的改写，已被改成自定义字号的行不会还原；
-- 现在记录第一次改写前的原始字体，回到"跟随游戏"时整体回滚。
local origFonts = setmetatable({}, { __mode = "k" })

local function RestoreFonts()
    for fs, orig in pairs(origFonts) do
        if fs and type(fs.SetFont) == "function" and type(orig.path) == "string" then
            pcall(fs.SetFont, fs, orig.path, orig.height, orig.flags or "")
        end
    end
    for fs in pairs(origFonts) do origFonts[fs] = nil end
end

-- 只改字号：保留每一行自己的字体族与 flags（不强写 GameFontNormal）。
-- 皮肤/字体插件设置的字体不受影响，也不会把物品名行的描边等标志抹掉。
local function ApplyFont(fontString, size)
    if not fontString or type(fontString.SetFont) ~= "function" then return end
    local ok, path, height, flags = pcall(fontString.GetFont, fontString)
    if ok and type(path) == "string" then
        if origFonts[fontString] == nil then
            origFonts[fontString] = { path = path, height = tonumber(height) or size, flags = flags }
        end
        pcall(fontString.SetFont, fontString, path, size, flags)
    else
        pcall(fontString.SetFont, fontString, GameFontPath(), size, "")
    end
end

local function ApplyTooltipFont(tooltip)
    if not tooltip then return end
    local size = ConfiguredSize()
    if not size then return end
    local name = tooltip.GetName and tooltip:GetName()

    local numLines = (type(tooltip.NumLines) == "function" and tooltip:NumLines()) or 0
    for i = 1, numLines do
        if name then
            -- 行号可能是浮点，必须用 %d 构造名字（Lua 5.3 下 1.0 .. "" == "1.0"）
            local index = math.floor(i)
            ApplyFont(_G[string.format("%sTextLeft%d", name, index)], size)
            ApplyFont(_G[string.format("%sTextRight%d", name, index)], size)
        end
    end

    -- 兜底：不按编号命名的 FontString（个别提示框如此）
    -- 0.9.4 修复：GetRegions 返回的是 **多个返回值（varargs）** 而不是表——
    -- 旧写法 `pcall(tooltip.GetRegions, tooltip)` 只接到第一个返回值，
    -- `type(regions) == "table"` 恒为假，这段兜底从未生效过。必须包进 { } 再遍历。
    if name and type(tooltip.GetRegions) == "function" then
        local ok, regions = pcall(function() return { tooltip:GetRegions() } end)
        if ok and type(regions) == "table" then
            for i = 1, #regions do
                local region = regions[i]
                if region and type(region.GetObjectType) == "function" then
                    local okType, kind = pcall(region.GetObjectType, region)
                    if okType and kind == "FontString" then
                        ApplyFont(region, size)
                    end
                end
            end
        end
    end
end

-- ── 当前角色行下方的红色下划线 ──────────────────────────────────────
-- 用 1px 纹理而不是下划线字符：更细、宽度自动贴合该行，且字号变化时自动跟着行底走。
local UNDERLINE_R, UNDERLINE_G, UNDERLINE_B = 1, 0.15, 0.15

local function HideUnderline(tooltip)
    local tex = tooltip and tooltip.__slUnderline
    if tex then tex:Hide() end
end

local function ShowUnderline(tooltip, fontString)
    if not (tooltip and fontString) then
        HideUnderline(tooltip)
        return
    end
    local tex = tooltip.__slUnderline
    if not tex then
        tex = tooltip:CreateTexture(nil, "ARTWORK", nil, 1)
        if tex.SetColorTexture then
            tex:SetColorTexture(UNDERLINE_R, UNDERLINE_G, UNDERLINE_B, 1)
        end
        tex:SetHeight(1)
        tooltip.__slUnderline = tex
    end
    if tex.ClearAllPoints then tex:ClearAllPoints() end
    tex:SetPoint("TOPLEFT", fontString, "BOTTOMLEFT", 0, 0)
    tex:SetPoint("TOPRIGHT", fontString, "BOTTOMRIGHT", 0, 0)
    tex:Show()
end

-- 提示框被复用于单位/法术等非物品内容时，不该留下上一条物品的下划线
local function IsItemTooltip(tooltip)
    if type(tooltip.GetItem) ~= "function" then return nil end   -- 无法判断
    local ok, _, link = pcall(tooltip.GetItem, tooltip)
    if not ok then return nil end
    return link ~= nil
end

-- 每个提示框的待插入状态（弱键表，tooltip → { itemID, lineCount, lastLine, lastLineType, inserted }）。
-- 审计 E1：只在 Item 型 pre-call 重置；若某次物品流程在 pre-call 之后被打断
--（如其它插件的 pre-call 终止了整个处理），残留状态可能被同帧的下一个提示框误用，
-- 因此配套两道防线：OnShow 清空 + lineIndex 兜底判据要求行类型一致（见 IsLastNativeLine）。
local pending = setmetatable({}, { __mode = "k" })

local function PendingOf(tooltip)
    local p = pending[tooltip]
    if not p then
        p = {}
        pending[tooltip] = p
    end
    return p
end

-- 非物品提示框（单位/法术/聊天链接）在显示时统一应用字号
local function EnsureShowHook(tooltip)
    if not tooltip or tooltip.__slHooked then return end
    if type(tooltip.HookScript) ~= "function" then return end
    tooltip.__slHooked = true
    tooltip:HookScript("OnShow", function(self)
        ApplyTooltipFont(self)
        -- 作废上一轮的待插入状态（E1 卫生层；行回调进行中的拦截靠 TooltipItemID 比对）
        pending[self] = nil
        if IsItemTooltip(self) == false then HideUnderline(self) end
    end)
    tooltip:HookScript("OnHide", function(self)
        HideUnderline(self)
        pending[self] = nil
    end)
end

EnsureShowHook(GameTooltip)
EnsureShowHook(ItemRefTooltip)

-- ── 插入位置：游戏原生说明之后、其他插件内容之前 ────────────────────
-- WoW 没有"插入行"的 API。官方流程（TooltipDataHandlerMixin:ProcessLines）会按顺序把
-- tooltipData.lines 里的原生行逐条加出来，并在**每加完一行**后调用 ProcessLinePostCalls()。
-- 因此：在原生行列表的**最后一行**加完之后插入我们的块 —— 此时游戏自带内容已全部就位，
-- 而其他插件（Auctionator 的卖价、EllesmereUI 的 ItemID 等）要等到 tooltipPostCall 才追加，
-- 所以我们的块正好落在两者之间。
-- 兜底：若判据拿不到（某些特殊流程），仍在 tooltipPostCall 末尾插入，功能不丢。

-- 括号对齐 v2：**固定像素列**。
-- 旧方案（按像素补空格）原理上就有 ±半个空格宽的残差，游戏内实测仍能看出错位。
-- 新方案：每行用 AddDoubleLine 分左右两列，然后把右列（TextRightN）统一重新锚定到
-- "最宽前缀"所在的固定 x 像素处、左对齐 —— 所有行的明细括号从**同一个像素**开始，
-- 结构上保证完全对齐，与字体、字号、名字长短无关。
-- 注意：重锚定发生在 Show 之前（行回调与兜底路径均如此），提示框布局会按新锚点计算。
local function AnchorDetailColumn(tooltip, rows, lineIndexes)
    if not rows or #rows == 0 or not lineIndexes then return end
    local name = tooltip.GetName and tooltip:GetName()
    if not name then return end

    local measure = tooltip.__slMeasure
    if not measure then
        measure = tooltip:CreateFontString(nil, "ARTWORK")
        tooltip.__slMeasure = measure
    end
    measure:Hide()

    -- 1) 量出每行"名字: 数量"的宽度（用该行左列自己的字体，且在字号已应用之后）
    local columnX = 0
    for i = 1, #rows do
        local fsL = _G[string.format("%sTextLeft%d", name, math.floor(lineIndexes[i]))]
        if not fsL or type(fsL.GetFont) ~= "function" then return end
        local ok, path, size, flags = pcall(fsL.GetFont, fsL)
        if not ok then return end
        if not pcall(measure.SetFont, measure, path, size, flags) then return end
        measure:SetText(PlainPrefix(rows[i]))
        local okW, width = pcall(measure.GetStringWidth, measure)
        width = (okW and tonumber(width)) or 0
        if width > columnX then columnX = width end
    end
    measure:SetText("")

    -- 2) 把每行右列锚到同一像素位置（左对齐，跟随左列顶端）
    for i = 1, #rows do
        local index = math.floor(lineIndexes[i])
        local fsL = _G[string.format("%sTextLeft%d", name, index)]
        local fsR = _G[string.format("%sTextRight%d", name, index)]
        if fsL and fsR and fsR.ClearAllPoints and fsR.SetPoint then
            if fsR.SetJustifyH then pcall(fsR.SetJustifyH, fsR, "LEFT") end
            fsR:ClearAllPoints()
            fsR:SetPoint("TOPLEFT", fsL, "TOPLEFT", columnX, 0)
        end
    end
end

-- 返回下划线要锚定的行号（没有则 nil）
local function AddCountBlock(tooltip, itemID)
    local rows = cache[itemID]
    if not rows then
        rows = BuildRows(itemID)
        if #rows > 0 then
            CachePut(itemID, rows)          -- 谁都没有的物品不缓存（省一张空表/条目）
        end
    end
    if #rows == 0 then return nil end        -- 一件都没有 → 整块不出现

    tooltip:AddLine(" ", 1, 1, 1, false)                     -- 与上方内容隔开
    tooltip:AddDoubleLine(RowPrefix(rows[1]), RowDetail(rows[1]), 1, 1, 1, 1, 1, 1, false)
    local underlineLine
    local lineIndexes = {}
    if type(tooltip.NumLines) == "function" then
        lineIndexes[1] = tooltip:NumLines()
        if rows[1].isPlayer then underlineLine = lineIndexes[1] end
    end
    for i = 2, #rows do
        tooltip:AddDoubleLine(RowPrefix(rows[i]), RowDetail(rows[i]), 1, 1, 1, 1, 1, 1, false)
        if type(tooltip.NumLines) == "function" then lineIndexes[i] = tooltip:NumLines() end
    end
    if SL:Get("showTotal") then
        local grand = 0
        for i = 1, #rows do grand = grand + rows[i].total end
        tooltip:AddLine(SL.L.TOTAL .. ": " .. Num(grand), 1, 1, 1, false)
    end
    tooltip:AddLine(" ", 1, 1, 1, false)                     -- 与下方内容隔开
    return underlineLine, lineIndexes, rows
end

local function FinalizeBlock(tooltip, underlineLine)
    ApplyTooltipFont(tooltip)
    local name = tooltip.GetName and tooltip:GetName()
    local anchor
    if underlineLine and name then
        anchor = _G[string.format("%sTextLeft%d", name, math.floor(underlineLine))]
    end
    ShowUnderline(tooltip, anchor)
end

-- 这一行是不是原生行列表的最后一行？
-- 主判据：表引用相等（客户端把 tooltipData.lines 里的同一张表传给回调）。
-- 兜底判据：行号相等 **且行类型一致**——审计 E1/E2：仅凭行号相等，单位提示框的
-- 某一行可能巧合命中残留的 lineCount 而误插；append 模式下行号也会累加错位。
-- 加类型一致后需要"行号+类型"双巧合，且 OnShow 已清残留，三层防护。
local function IsLastNativeLine(tooltip, lineData)
    local p = pending[tooltip]
    if not p then return false end
    if p.lastLine ~= nil and lineData == p.lastLine then return true end   -- 同一张表（客户端行为）
    local index = lineData and lineData.lineIndex
    if p.lineCount == nil or index == nil or index ~= p.lineCount then return false end
    if p.lastLineType ~= nil then
        local lineType = lineData and lineData.type
        if lineType ~= p.lastLineType then return false end
    end
    return true
end

-- 插入整块：加行 → 应用字号 → 固定像素列对齐括号
local function InsertBlock(tooltip, itemID)
    local underlineLine, lineIndexes, rows = AddCountBlock(tooltip, itemID)
    if not lineIndexes then return end           -- 谁都没有 → 什么都不加
    FinalizeBlock(tooltip, underlineLine)        -- 先定字号，列位置按最终字体测量
    AnchorDetailColumn(tooltip, rows, lineIndexes)
end

-- 提示框当前显示的物品 ID。
-- 返回 nil = 无法判断（无 GetItem，如部分模拟环境/非常规提示框）；
-- 返回 false = 明确不是物品提示框；返回数字 = 物品 ID。
local function TooltipItemID(tooltip)
    if type(tooltip.GetItem) ~= "function" then return nil end
    local ok, _, link = pcall(tooltip.GetItem, tooltip)
    if not ok then return nil end
    if type(link) ~= "string" then return false end
    return tonumber(link:match("item:(%d+)")) or false
end

local function OnAnyLine(tooltip, lineData)
    local p = pending[tooltip]
    if not p or p.inserted or not p.itemID then return end
    if not IsLastNativeLine(tooltip, lineData) then return end
    -- 审计 E1 主防线：插入前确认这个提示框当前显示的**就是我们记下的那件物品**。
    -- 残留状态（物品流程被打断后复用同一提示框）在单位/法术行回调里行号+类型
    -- 双巧合命中时，会被这里的 GetItem 比对拦下；物品 ID 对不上同样不插。
    local current = TooltipItemID(tooltip)
    if current == false then return end
    if type(current) == "number" and current ~= p.itemID then return end
    p.inserted = true
    InsertBlock(tooltip, p.itemID)
end

-- 兜底：物品名行回调没触发时，仍在末尾插入
local function OnItemTooltip(tooltip, data)
    if not (tooltip and data and data.id) then return end
    if type(tooltip.AddLine) ~= "function" then return end

    local p = PendingOf(tooltip)
    p.itemID = data.id

    if not p.inserted then
        p.inserted = true
        InsertBlock(tooltip, data.id)
    else
        ApplyTooltipFont(tooltip)          -- 已插入过：只需再确保全局字号覆盖到全部行
    end
end

if TooltipDataProcessor and Enum and Enum.TooltipDataType then
    -- 1) 所有行生成之前：拿到物品 ID，并记下原生行总数与最后一行
    if TooltipDataProcessor.AddTooltipPreCall then
        TooltipDataProcessor.AddTooltipPreCall(Enum.TooltipDataType.Item, function(tooltip, data)
            local p = PendingOf(tooltip)
            p.itemID = data and data.id or nil
            p.inserted = false
            local lines = data and data.lines
            if type(lines) == "table" then
                p.lineCount = #lines
                p.lastLine = lines[#lines]
                p.lastLineType = lines[#lines] and lines[#lines].type or nil
            else
                p.lineCount = nil
                p.lastLine = nil
                p.lastLineType = nil
            end
        end)
    end
    -- 2) 注册到全部行类型，只为在"最后一行原生内容"之后插入（我们加行时不会触发逐行回调，无递归）
    if TooltipDataProcessor.AddLinePostCall and Enum.TooltipDataLineType then
        local seen = {}
        for _, lineType in pairs(Enum.TooltipDataLineType) do
            if type(lineType) == "number" and not seen[lineType] then
                seen[lineType] = true
                TooltipDataProcessor.AddLinePostCall(lineType, OnAnyLine)
            end
        end
    end
    -- 3) 兜底路径
    if TooltipDataProcessor.AddTooltipPostCall then
        TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, OnItemTooltip)
    end
end

-- ── 已显示的提示框实时刷新（0.9.4，来自对抗审计） ──────────────────
-- 审计确认的显示滞后：数据或字号变化只清缓存，**已经画出来的**提示框要等下一次
-- 悬停才更新——悬停中消耗/存入物品时数字会停在旧值。这里在变化后重放一次当前内容：
-- SetHyperlink(原链接) 会让客户端重新走一遍 TooltipDataProcessor 流程（清空重建），
-- 我们的 pre/line/post 回调随之重跑，于是拿到的是清缓存后的新数字、新字号。
-- 用 0.05s 去抖合并连续变化（背包批量变动时不会反复重建）。
local REFRESH_TOOLTIPS = { GameTooltip, ItemRefTooltip }

local function RefreshShownTooltips()
    for i = 1, #REFRESH_TOOLTIPS do
        local tooltip = REFRESH_TOOLTIPS[i]
        if tooltip and type(tooltip.IsShown) == "function" and tooltip:IsShown()
            and type(tooltip.GetItem) == "function" and type(tooltip.SetHyperlink) == "function" then
            local ok, _, link = pcall(tooltip.GetItem, tooltip)
            if ok and type(link) == "string" then
                pcall(tooltip.SetHyperlink, tooltip, link)
            end
        end
    end
end

-- 数据 / 装备变化 → 缓存作废 + 重放当前提示框
local function InvalidateAndRefresh()
    ClearCache()
    SL:Debounce("tooltipRefresh", 0.05, RefreshShownTooltips)
end

SL:Subscribe("DATA_CHANGED", InvalidateAndRefresh)
-- 换装同样要走这条：装备数进了「背」的口径，摘下一枚戒指就得重算
SL:Subscribe("EQUIPMENT_CHANGED", InvalidateAndRefresh)
SL:Subscribe("CONFIG_CHANGED", function()
    ClearCache()
    -- 字号回到"跟随游戏"（或任何 <=0 的值）时，把被我们改过字号的行全部还原
    if ConfiguredSize() == nil then RestoreFonts() end
    -- 字号/勾选变化后，同样让已经打开的提示框立即更新（例如面板开着改字号）
    SL:Debounce("tooltipRefresh", 0.05, RefreshShownTooltips)
end)

function Tooltip:ClearCache()
    ClearCache()
end

-- 当前缓存条数（供测试与诊断）
function Tooltip:CacheSize()
    local n = 0
    for i = 1, #cacheFifo do
        if cache[cacheFifo[i]] ~= nil then n = n + 1 end
    end
    return n
end
