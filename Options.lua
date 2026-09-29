-- StockTake 简化版 · 设置面板
-- 全部使用暴雪原生控件（SettingsCheckboxTemplate / SettingsSliderTemplate），零自绘。
local ADDON_NAME, SL = ...

SL.Options = {}
local Options = SL.Options

local function HasTemplate(name)
    local util = C_XMLUtil
    if not (util and util.GetTemplateInfo) then return false end
    local ok, info = pcall(util.GetTemplateInfo, name)
    return ok and info ~= nil
end

local CHECKBOX_TEMPLATE = HasTemplate("SettingsCheckboxTemplate")
    and "SettingsCheckboxTemplate" or "InterfaceOptionsCheckButtonTemplate"
local SLIDER_TEMPLATE = HasTemplate("SettingsSliderTemplate")
    and "SettingsSliderTemplate" or "OptionsSliderTemplate"

local panel = CreateFrame("Frame")
panel.name = ADDON_NAME

-- ── 控件命名与标签 ──────────────────────────────────────────────────
-- 两个坑（都是实测踩到的）：
--   1) 暴雪模板里的文本子元素若是 $parentText 形式，需要控件**有全局名**才会被创建；
--   2) SettingsCheckboxTemplate **本身没有任何文本元素**（Blizzard 的标签放在外层
--      SettingsCheckboxControlTemplate 容器里），而对它调用 Button:SetText 会自己造一个
--      **没有锚点**的 FontString —— API 读回校验能通过，但字看不见。
-- 因此：勾选框的标签一律由本插件自建（带明确锚点）；滑条等有自带文本的模板走"读回校验"。
local controlIndex = 0
local function NextName(prefix)
    controlIndex = controlIndex + 1
    return prefix .. controlIndex
end

local function OwnLabel(control, label, gap)
    local fs = control:CreateFontString(NextName("StockTakeOptLabel"), "ARTWORK", "GameFontHighlight")
    fs:SetPoint("LEFT", control, "RIGHT", gap or 8, 0)
    fs:SetJustifyH("LEFT")
    fs:SetText(label)
    return fs
end

-- 设置标签；返回"最终承载文字的 FontString"（供语言切换时重贴，0.9.5）
local function SetLabel(control, label, gap, forceOwn)
    if type(label) ~= "string" or label == "" then return nil end

    if not forceOwn then
        local text = control.Text
        if text and type(text.SetText) == "function" then
            text:SetText(label)
            if type(text.GetText) ~= "function" or text:GetText() == label then return text end
        end
    end

    return OwnLabel(control, label, gap)
end

local function AttachTooltip(frame, text)
    if not text then return end
    -- 关掉模板自带的悬停效果：DefaultTooltipMixin:OnEnter 里有 self.HoverBackground:Show()
    -- （在深色面板上就是一块反白背景），并会弹出它自己的 SettingsTooltip。
    -- 这里直接接管 OnEnter/OnLeave → 不显示悬停背景，只弹本插件的提示。
    if frame.HoverBackground then frame.HoverBackground:Hide() end
    frame:SetScript("OnEnter", function(self)
        if not GameTooltip then return end
        GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
        GameTooltip:SetText(text, 1, 1, 1, 1, true)
        GameTooltip:Show()
    end)
    frame:SetScript("OnLeave", function()
        if GameTooltip then GameTooltip:Hide() end
    end)
end

-- 0.9.5：可重贴的标签登记表。面板文字不能再在文件加载期"定死"——
-- 那时 SavedVariables 还没到（ADDON_LOADED 才有），/st en 的语言覆盖读不到，
-- 标题/复选框/滑条会永远停在客户端语言；滑条初值也只能读到默认值。
local relabelers = {}
local function OnRelabel(fn) relabelers[#relabelers + 1] = fn end
local function RelabelPanel()
    for i = 1, #relabelers do pcall(relabelers[i]) end
end

local function AddCheckbox(y, labelKey, tipKey, key)
    local cb = CreateFrame("CheckButton", NextName("StockTakeOptCheck"), panel, CHECKBOX_TEMPLATE)
    cb:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, y)
    local fs = SetLabel(cb, SL.L[labelKey], 8, true)   -- 勾选框模板无文本元素 → 一律自建标签
    cb:SetChecked(SL:Get(key) and true or false)
    cb:SetScript("OnClick", function(self)
        SL:Set(key, self:GetChecked() and true or false)
    end)
    AttachTooltip(cb, SL.L[tipKey])
    OnRelabel(function()
        if fs then fs:SetText(SL.L[labelKey]) end
        AttachTooltip(cb, SL.L[tipKey])
    end)
    return cb
end

-- 角色筛选勾选框：label 可带颜色码；disabled 时仅展示、不可交互
-- 返回 cb, 标签 FontString（后者供语言切换时重贴，0.9.5）
local function AddCharCheckbox(y, label, tooltip, checked, onClick, disabled)
    local cb = CreateFrame("CheckButton", NextName("StockTakeOptCheck"), panel, CHECKBOX_TEMPLATE)
    cb:SetPoint("TOPLEFT", panel, "TOPLEFT", 32, y)
    local fs = SetLabel(cb, label, 8, true)
    cb:SetChecked(checked and true or false)
    if disabled then
        if cb.Enable then pcall(cb.Disable, cb) end
        if cb.SetEnabled then cb:SetEnabled(false) end
    else
        cb:SetScript("OnClick", function(self)
            onClick(self:GetChecked() and true or false)
        end)
    end
    AttachTooltip(cb, tooltip)
    return cb, fs
end

-- ── 角色筛选区：列出已记录的角色，勾选决定是否出现在提示框 ─────────
-- v0.9.2 修复：此前挂在"首次 Options:Open()"上，玩家经 ESC→选项 打开面板时
-- 永远看不到这一区（Open 只在 /st 命令路径被调用）。改为 PLAYER_READY 时构建——
-- 此时 SL2_DB 已加载、SL.player 已就绪、历史角色记录都在。
local charSectionBuilt = false
local function BuildCharSection(startY)
    if charSectionBuilt then return end
    charSectionBuilt = true
    local header = panel:CreateFontString(nil, "ARTWORK", "GameFontNormal")
    header:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, startY)
    header:SetText(SL.L.CHAR_SELECT)
    AttachTooltip(header, SL.L.CHAR_SELECT_TIP)
    -- 语言切换时一并重贴（角色名是数据，不变；变的是标题、提示与"当前角色"后缀）
    OnRelabel(function()
        header:SetText(SL.L.CHAR_SELECT)
        AttachTooltip(header, SL.L.CHAR_SELECT_TIP)
    end)

    -- 收集角色（按名字排序），当前角色排最前且不可取消
    local list = {}
    if type(SL2_DB) == "table" and type(SL2_DB.chars) == "table" then
        for key, rec in pairs(SL2_DB.chars) do
            if type(rec) == "table" then
                list[#list + 1] = {
                    key = key,
                    name = tostring(rec.name or key),
                    class = rec.class,
                    isSelf = (SL.player and key == SL.player.key) or false,
                }
            end
        end
    end
    table.sort(list, function(a, b)
        if a.isSelf ~= b.isSelf then return a.isSelf end
        return a.name < b.name
    end)

    local y = startY - 26
    for _, entry in ipairs(list) do
        local base = entry.name                      -- 角色名（数据，不随语言变）
        local color = RAID_CLASS_COLORS and entry.class and RAID_CLASS_COLORS[entry.class]
        if color and color.colorStr then
            base = "|c" .. color.colorStr .. base .. "|r"
        end
        local label = base
        if entry.isSelf then label = label .. SL.L.CHAR_SELF_NOTE end

        local _, fs
        if entry.isSelf then
            _, fs = AddCharCheckbox(y, label, nil, true, nil, true)
        else
            _, fs = AddCharCheckbox(y, label, nil, not SL:IsCharHidden(entry.key), function(checked)
                SL:SetCharHidden(entry.key, not checked)
            end)
        end
        OnRelabel(function()
            if not fs then return end
            fs:SetText(entry.isSelf and (base .. SL.L.CHAR_SELF_NOTE) or base)
        end)
        y = y - 24
    end
end

-- 登录完成后构建角色筛选区（PLAYER_READY 在 Core 的 PLAYER_ENTERING_WORLD 末尾触发，
-- 此时 SL2_DB 已加载、SL.player 已就绪、历史角色记录都在）——ESC→选项 与 /st 两条路径都可见。
-- 新角色在本次会话中首次登录不会出现在列表里（面板已建好），/reload 后即可见。
SL:Subscribe("PLAYER_READY", function()
    BuildCharSection(-175)
end)

local function AddSlider(y, labelKey, tipKey, key, minValue, maxValue, step, display)
    local slider = CreateFrame("Slider", NextName("StockTakeOptSlider"), panel, SLIDER_TEMPLATE)
    slider:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, y)
    slider:SetMinMaxValues(minValue, maxValue)
    slider:SetValueStep(step or 1)
    if slider.SetObeyStepOnDrag then slider:SetObeyStepOnDrag(true) end
    local nameFs = SetLabel(slider, SL.L[labelKey])
    if slider.Low then slider.Low:SetText(tostring(minValue)) end
    if slider.High then slider.High:SetText(tostring(maxValue)) end

    local function Format(value)
        if display then return display(value) end
        return tostring(value)
    end

    local valueText = slider:CreateFontString(nil, "ARTWORK", "GameFontHighlight")
    valueText:SetPoint("LEFT", slider, "RIGHT", 12, 0)

    slider:SetScript("OnValueChanged", function(self, value)
        value = math.floor((tonumber(value) or minValue) + 0.5)
        -- 0.9.4 修复：渲染端最小字号是 6（Tooltip 侧 FONT_MIN），此前 1–5 档
        -- "显示 3、实际渲染 6"。这里直接吸附到 6，消除错位；0 仍 = 跟随游戏。
        -- 吸附会再次触发本回调（值为 6），条件不再命中，幂等无递归。
        if key == "fontSize" and value > 0 and value < 6 then
            value = 6
            pcall(self.SetValue, self, 6)
        end
        SL:Set(key, value)
        valueText:SetText(Format(value))
    end)
    local current = SL:Get(key)
    if type(current) ~= "number" then current = minValue end
    slider:SetValue(current)
    valueText:SetText(Format(current))

    AttachTooltip(slider, SL.L[tipKey])
    OnRelabel(function()
        if nameFs then nameFs:SetText(SL.L[labelKey]) end
        local v = SL:Get(key)
        if type(v) ~= "number" then v = minValue end
        valueText:SetText(Format(v))
        AttachTooltip(slider, SL.L[tipKey])
    end)
    return slider
end

-- ── 面板内容（在 SavedVariables 就绪后构建，见文件末尾 DB_READY 订阅） ──
local RegisterCategory                       -- 前置声明（定义见下）
local panelBuilt = false
local function BuildPanel()
    if panelBuilt then return end
    panelBuilt = true

    local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
    title:SetPoint("TOPLEFT", panel, "TOPLEFT", 16, -16)
    title:SetText(SL.L.ADDON_TITLE)

    local hint = panel:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
    hint:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
    hint:SetText(SL.L.HINT)

    -- 0.9.4：移除「显示其他角色」复选框——它与下方「显示哪些角色」勾选列表完全重复
    -- （全部取消勾选即"只看自己"）。面板上移 30px 补上腾出的行。
    AddCheckbox(-70,  "SHOW_TOTAL", "SHOW_TOTAL_TIP", "showTotal")
    AddSlider(-125, "FONT_SIZE", "FONT_SIZE_TIP", "fontSize", 0, 32, 1, function(value)
        if value <= 0 then return SL.L.FOLLOW_GAME end
        return tostring(value)
    end)

    OnRelabel(function()
        title:SetText(SL.L.ADDON_TITLE)
        hint:SetText(SL.L.HINT)
    end)

    RegisterCategory()
end

-- ── 注册到 ESC → 选项 → 插件（失败则退回旧接口）────────────────────
local registered = false
RegisterCategory = function()
    if registered then return end
    registered = true
    if Settings and Settings.RegisterCanvasLayoutCategory and Settings.RegisterAddOnCategory then
        local ok, category = pcall(Settings.RegisterCanvasLayoutCategory, panel, SL.L.ADDON_TITLE, ADDON_NAME)
        if ok and category then
            panel.category = category
            pcall(Settings.RegisterAddOnCategory, category)
            return
        end
    end
    if InterfaceOptions_AddCategory then
        pcall(InterfaceOptions_AddCategory, panel)
    end
end

function Options:Open()
    BuildPanel()                         -- 保险：DB_READY 之前被调用也能建
    BuildCharSection(-175)               -- 幂等：PLAYER_READY 已建则跳过（/st 路径保险）
    if panel.category and Settings and Settings.OpenToCategory then
        pcall(Settings.OpenToCategory, panel.category:GetID())
        return
    end
    if InterfaceOptionsFrame_OpenToCategory then
        pcall(InterfaceOptionsFrame_OpenToCategory, panel)
    end
end

-- SavedVariables 就绪（ADDON_LOADED 之后）再构建面板：语言覆盖与已保存字号都读得到
SL:Subscribe("DB_READY", BuildPanel)
-- 语言切换即时重贴标签（不必 /reload；左侧分类名仍随下次重载同步）
SL:Subscribe("CONFIG_CHANGED", function(key)
    if key == "locale" then RelabelPanel() end
end)

-- ── 斜杠命令 ────────────────────────────────────────────────────────
-- /st            打开设置
-- /st en         预览英文（提示框即时生效）
-- /st zh         预览中文
-- /st auto       恢复跟随客户端语言
-- /st clean [天] 清理超过 N 天（默认 30）未登录的角色记录，缩减内存与存档
local function Notify(key)
    local text = SL.L[key]
    if type(text) ~= "string" or type(print) ~= "function" then return end
    print("|cffe6b84c" .. SL.L.ADDON_TITLE .. "|r " .. text)
end

local function SetLocalePreview(value)
    if type(SL2_DB) ~= "table" then
        Notify("MSG_LOCALE_BAD")
        return
    end
    if type(SL2_DB.options) ~= "table" then SL2_DB.options = {} end
    -- 必须走 SL:Set 而不是直写存档：SL:Set 会派发 CONFIG_CHANGED，
    -- 设置面板才能即时重贴标签。（0.9.5 修复：直写时存档值变了、提示框也变了，
    -- 但面板文字不会跟着变——单元测试若直接调 API 就测不出这条真实路径。）
    SL:Set("locale", value)
    if value == "enUS" then
        Notify("MSG_LOCALE_EN")
    elseif value == "zhTW" then
        Notify("MSG_LOCALE_TW")
    elseif value == "zhCN" then
        Notify("MSG_LOCALE_ZH")
    else
        Notify("MSG_LOCALE_AUTO")
    end
end

local function CleanOldChars(days)
    local removed, kept, entries = SL:CleanOldChars(days)
    if type(print) == "function" then
        print(("|cffe6b84c%s|r %s"):format(SL.L.ADDON_TITLE,
            (SL.L.CLEAN_DONE):format(removed, tonumber(days) or 30, kept, entries)))
    end
end

if type(SlashCmdList) == "table" then
    SlashCmdList["STOCKTAKE"] = function(msg)
        local action, arg = tostring(msg or ""):lower():match("^%s*(%S*)%s*(.-)%s*$")
        if action == "en" or action == "enus" or action == "english" then
            SetLocalePreview("enUS")
        elseif action == "tw" or action == "zhtw" or action == "traditional" or action == "hk" then
            SetLocalePreview("zhTW")
        elseif action == "zh" or action == "zhcn" or action == "chinese" or action == "cn" then
            SetLocalePreview("zhCN")
        elseif action == "auto" then
            SetLocalePreview(nil)
        elseif action == "clean" then
            CleanOldChars(tonumber(arg))
        else
            Options:Open()
        end
    end
end
