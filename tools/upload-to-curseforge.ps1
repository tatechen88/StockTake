<#
.SYNOPSIS
    把已打包的 zip 上传到 CurseForge 项目（走官方上传 API）。

.DESCRIPTION
    CurseForge 没有"创建项目"的 API —— 项目必须先在网页上建好并通过审核。
    但**上传发布文件**有 API，本脚本就是用它：
        POST https://wow.curseforge.com/api/projects/<项目ID>/upload-file
        Header: X-Api-Token: <你的 API Token>
        Body  : multipart/form-data  →  metadata(JSON) + file(zip)

    前置条件（只能由作者本人完成）：
      1. 在 https://authors.curseforge.com 建好项目，拿到**数字项目 ID**（About Project 里）；
      2. 在 CurseForge 账号页生成 API Token，放进环境变量 CF_API_TOKEN（不要写进任何文件）。

.EXAMPLE
    # 先干跑：只打印将要发送的元数据，不真的上传
    pwsh -File upload-to-curseforge.ps1 -ProjectId 1234567 -DryRun

.EXAMPLE
    # 真上传（token 来自环境变量）
    $env:CF_API_TOKEN = '<粘贴一次，不要保存进文件>'
    pwsh -File upload-to-curseforge.ps1 -ProjectId 1234567
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$ProjectId,
    [string]$ZipPath = (Get-ChildItem -Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist') -Filter '*.zip' -File |
                        Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName),
    [ValidateSet('release', 'beta', 'alpha')][string]$ReleaseType = 'release',
    [string[]]$GameVersions = @('12.1.0'),
    [string]$DisplayName,
    [string]$Changelog,
    [string]$ChangelogFile,
    [string]$Token = $env:CF_API_TOKEN,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Fail($m) { Write-Host "FAIL  $m" -ForegroundColor Red; exit 1 }
function Ok($m)   { Write-Host "OK    $m" -ForegroundColor Green }

# ---- 校验输入 ----
if (-not $ZipPath -or -not (Test-Path -LiteralPath $ZipPath)) { Fail "找不到要上传的 zip（先跑 build-release.ps1）" }
$ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
$zipItem = Get-Item -LiteralPath $ZipPath
Ok "发布包: $($zipItem.Name)  ($([math]::Round($zipItem.Length/1KB,1)) KB)"

# 结构复检：根层必须只有一个与 toc 同名的文件夹（CF 处理器的硬规则）
Add-Type -AssemblyName System.IO.Compression.FileSystem
$arc = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try { $entries = $arc.Entries | ForEach-Object { $_.FullName } } finally { $arc.Dispose() }
$roots = @($entries | ForEach-Object { ($_ -split '/')[0] } | Sort-Object -Unique)
if ($roots.Count -ne 1) { Fail "zip 根层应恰好一个文件夹，实际: $($roots -join ', ')" }
$root = $roots[0]
if ($entries -notcontains "$root/$root.toc") { Fail "zip 内缺少 $root/$root.toc" }
Ok "结构合规: $root/$root.toc"

$arc = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
    $entry   = $arc.GetEntry("$root/$root.toc")
    $reader  = New-Object System.IO.StreamReader($entry.Open())
    $tocText = $reader.ReadToEnd()
    $reader.Dispose()
} finally { $arc.Dispose() }
$mVer = [regex]::Match($tocText, '(?m)^\s*##\s*Version:\s*(.+?)\s*$')
$tocVersion = if ($mVer.Success) { $mVer.Groups[1].Value } else { 'unknown' }
$mIface = [regex]::Match($tocText, '(?m)^\s*##\s*Interface:\s*(.+?)\s*$')
Ok "toc 版本 $tocVersion ｜ Interface $($mIface.Groups[1].Value)"

if (-not $DisplayName) { $DisplayName = $tocVersion }
if (-not $Changelog) {
    if ($ChangelogFile -and (Test-Path -LiteralPath $ChangelogFile)) {
        $Changelog = Get-Content -LiteralPath $ChangelogFile -Raw -Encoding UTF8
    } else {
        $Changelog = "Release $tocVersion"
    }
}

# ---- 组装官方要求的 metadata ----
$meta = [ordered]@{
    changelog     = $Changelog
    changelogType = 'markdown'
    displayName   = $DisplayName
    releaseType   = $ReleaseType
    gameVersions  = @($GameVersions)
}
$metaJson = $meta | ConvertTo-Json -Compress -Depth 5

Write-Host "`n--- 将要提交的内容 ---" -ForegroundColor Cyan
Write-Host "项目 ID      : $ProjectId"
Write-Host "文件         : $($zipItem.FullName)"
Write-Host "displayName  : $DisplayName"
Write-Host "releaseType  : $ReleaseType   (release = 会同步给 CurseForge App)"
Write-Host "gameVersions : $($GameVersions -join ', ')"
Write-Host "changelog    : $($Changelog.Length) 字符"
Write-Host "endpoint     : POST https://wow.curseforge.com/api/projects/$ProjectId/upload-file"
Write-Host "metadata     : $metaJson"
Write-Host "token        : $(if ($Token) { '已提供（不回显）' } else { '缺失' })"

if ($DryRun) { Write-Host "`n(干跑模式，未发送任何请求)" -ForegroundColor Yellow; exit 0 }
if (-not $Token) { Fail "缺少 API Token：设置环境变量 CF_API_TOKEN 后再执行（不要写进文件、不要贴进聊天）" }

# ---- 发送 ----
$uri = "https://wow.curseforge.com/api/projects/$ProjectId/upload-file"
$headers = @{ 'X-Api-Token' = $Token; 'Accept' = 'application/json' }
$form = @{
    metadata = $metaJson
    file     = $zipItem
}
try {
    $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Form $form -TimeoutSec 300
} catch {
    $detail = $_.ErrorDetails.Message
    Fail "上传失败: $($_.Exception.Message) $(if ($detail) { "| 服务端返回: $detail" })"
}

Ok "上传成功，CurseForge 文件 ID: $($resp.id)"
Write-Host @"

后续（上传后会被审核，"Under Review" 是正常的）：
  1. 到项目 Files 页确认版本标签是 12.1.0、类型是 Release；
  2. 把这两行写回 .toc 并重新打包下一个版本：
       ## X-Curse-Project-ID: $ProjectId
       ## X-Website: https://www.curseforge.com/wow/addons/<你的slug>
"@ -ForegroundColor Cyan
