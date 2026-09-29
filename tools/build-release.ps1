<#
.SYNOPSIS
    打包 StockTake (StockTake) 的 CurseForge 发布包。

.DESCRIPTION
    1. 从 .toc 读取版本号；
    2. 校验 .toc 里列出的每个 .lua 都存在、且 .toc 文件名 == 文件夹名（WoW 硬性要求）；
    3. 生成 dist\<AddonName>-<version>.zip，zip 内顶层目录固定为插件文件夹名；
    4. 回读 zip 条目列表并打印，作为上传前的人工核对依据。

    dev-only 目录（tools / docs / reports / .git / .scratch / node_modules …）不会进包，
    所以默认在仓库根目录运行是安全的。

.EXAMPLE
    # 默认：就地打包本仓库（仓库根目录 = 插件本体）
    pwsh -File build-release.ps1

.EXAMPLE
    # 也可以指向游戏内的运行副本
    pwsh -File build-release.ps1 -AddonPath 'D:\...\AddOns\StockTake'
#>
[CmdletBinding()]
param(
    [string]$AddonPath = (Split-Path -Parent $PSScriptRoot),
    [string]$OutDir    = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist')
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "FAIL  $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "OK    $msg" -ForegroundColor Green }

if (-not (Test-Path -LiteralPath $AddonPath)) { Fail "插件目录不存在: $AddonPath" }

$addonDir  = (Resolve-Path -LiteralPath $AddonPath).Path
$addonName = Split-Path -Leaf $addonDir
$tocPath   = Join-Path $addonDir "$addonName.toc"

if (-not (Test-Path -LiteralPath $tocPath)) {
    Fail ".toc 文件名必须与文件夹名一致：找不到 $addonName.toc（WoW 会因此不加载插件）"
}
Ok ".toc 命名合法: $addonName/$addonName.toc"

$tocLines = Get-Content -LiteralPath $tocPath -Encoding UTF8
$version  = ($tocLines | Where-Object { $_ -match '^\s*##\s*Version:\s*(.+?)\s*$' } |
             ForEach-Object { $Matches[1] } | Select-Object -First 1)
if (-not $version) { Fail ".toc 里没有 ## Version: 字段" }
Ok "版本号: $version"

$iface = ($tocLines | Where-Object { $_ -match '^\s*##\s*Interface:\s*(.+?)\s*$' } |
          ForEach-Object { $Matches[1] } | Select-Object -First 1)
Ok "Interface: $iface"

# .toc 中非注释、非空行 = 必须被打包的文件
$listed = $tocLines | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' } |
          ForEach-Object { $_.Trim() }
$missing = $listed | Where-Object { -not (Test-Path -LiteralPath (Join-Path $addonDir $_)) }
if ($missing) { Fail ("以下 .toc 引用的文件缺失: " + ($missing -join ', ')) }
Ok ("toc 引用文件齐全: {0} 个（{1}）" -f $listed.Count, ($listed -join ', '))

# 允许进包的文件类型；顺带挡掉编辑器/系统垃圾文件（IconTexture 校验也要用，故先定义）
$allowExt = @('.toc', '.lua', '.xml', '.md', '.txt', '.tga', '.png', '.blp')
$junk     = @('.DS_Store', 'Thumbs.db', 'desktop.ini')

# IconTexture 资产校验（0.9.4）：声明了图标 → 文件必须存在、类型可打包、且要出现在 zip 里。
# 这条校验来自对抗审计：toc 引用检查只看非注释行，## 元数据完全不在其列——
# 图标路径写错/文件漏拷时旧脚本照样打出一个"看起来正常"的包。
$iconRel = $null
$iconLine = $tocLines | Where-Object { $_ -match '^\s*##\s*IconTexture:\s*(.+?)\s*$' } | Select-Object -First 1
if ($iconLine) {
    $iconPath = $Matches[1]
    $iconNorm = $iconPath -replace '/', '\'
    $iconPrefix = "Interface\AddOns\$addonName\"
    if (-not $iconNorm.StartsWith($iconPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Fail "IconTexture 不是本插件内路径: $iconPath"
    }
    $iconRel = $iconNorm.Substring($iconPrefix.Length)
    if (-not (Test-Path -LiteralPath (Join-Path $addonDir $iconRel))) {
        Fail "IconTexture 指向的文件不存在: $addonName\$iconRel"
    }
    $iconExt = [System.IO.Path]::GetExtension($iconRel).ToLower()
    if ($allowExt -notcontains $iconExt) { Fail "IconTexture 文件类型不在打包白名单 (.tga/.png/.blp): $iconRel" }
    Ok "IconTexture 资产存在且类型合法: $iconRel"
}

# 开发专用目录/文件永不进包。仓库根目录就是插件本体，所以这些必须显式排除——
# 否则 docs\*.md 与 docs\images\*.png 会被打进发布包（两者的扩展名都在白名单里）。
$devDirs  = @('tools', 'docs', 'reports', 'dist', 'tests', '.git', '.github', '.scratch', 'node_modules')
$devFiles = @('AGENTS.md', 'HANDOFF.md')

function Get-AddonRel($item) { $item.FullName.Substring($addonDir.Length).TrimStart('\') }
function Test-DevOnly($rel) {
    if ($devDirs -contains ($rel -split '\\')[0]) { return $true }
    return $devFiles -contains $rel
}

# 收集要进包的文件（先排除开发专用，再按上面的白名单/垃圾名单过滤）
$all      = @(Get-ChildItem -LiteralPath $addonDir -File -Recurse)
$devOnly  = @($all | Where-Object { Test-DevOnly (Get-AddonRel $_) })
$runtime  = @($all | Where-Object { -not (Test-DevOnly (Get-AddonRel $_)) })
$files    = @($runtime | Where-Object { $allowExt -contains $_.Extension.ToLower() } |
                        Where-Object { $junk -notcontains $_.Name })
$skipped  = @($runtime | Where-Object { $allowExt -notcontains $_.Extension.ToLower() -or $junk -contains $_.Name })
foreach ($s in $skipped) { Write-Host "SKIP  $($s.Name)（不进发布包）" -ForegroundColor DarkYellow }
Write-Host ("SKIP  开发专用文件 {0} 个（tools / docs / .git / .scratch / node_modules …）" -f $devOnly.Count) -ForegroundColor DarkYellow

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$zip    = Join-Path $OutDir "$addonName-$version.zip"

# 用暂存目录保证 zip 内顶层目录 = 插件文件夹名
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("sl-rel-" + [guid]::NewGuid().ToString('N'))
$inner = Join-Path $stage $addonName
New-Item -ItemType Directory -Path $inner -Force | Out-Null
foreach ($f in $files) {
    $rel  = $f.FullName.Substring($addonDir.Length).TrimStart('\')
    $dest = Join-Path $inner $rel
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
}

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path $inner -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force

# 回读校验：顶层文件夹、toc 位置、条目数
Add-Type -AssemblyName System.IO.Compression.FileSystem
$arc = [System.IO.Compression.ZipFile]::OpenRead($zip)
try { $entries = $arc.Entries | ForEach-Object { $_.FullName } } finally { $arc.Dispose() }

$badRoot = $entries | Where-Object { $_.Split('/')[0] -ne $addonName }
if ($badRoot) { Fail ("zip 内存在顶层目录不是 $addonName 的条目: " + ($badRoot -join ', ')) }
if ($entries -notcontains "$addonName/$addonName.toc") {
    Fail "zip 内缺少 $addonName/$addonName.toc（排序异常或结构错误）"
}
if ($entries.Count -ne $files.Count) {
    Fail "zip 条目数 $($entries.Count) 与预期文件数 $($files.Count) 不一致"
}
if ($iconRel -and ($entries -notcontains (“$addonName/” + ($iconRel -replace '\\', '/')))) {
    Fail “zip 内缺少 IconTexture 资产: $iconRel”
}

Ok "发布包已生成: $zip"
Write-Host ("     大小: {0:N1} KB    条目: {1}" -f ((Get-Item -LiteralPath $zip).Length / 1KB), $entries.Count)
Write-Host "     内容:" -ForegroundColor Cyan
$entries | Sort-Object | ForEach-Object { Write-Host "       $_" }
