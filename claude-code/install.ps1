# DeskFox claude-code plugin installer
# 自动探测 claude.exe + 写入 ~/.config/opencode/opencode.jsonc 的 provider['claude-code'] 节

$ErrorActionPreference = 'Stop'

$PluginRoot = $PSScriptRoot
$DistPath = Join-Path $PluginRoot 'dist\index.js'
$PkgJson = Join-Path $PluginRoot 'package.json'

# 读取 plugin 自身版本号 (失败不致命, 装完打印用)
$PluginVersion = "unknown"
if (Test-Path $PkgJson) {
  try {
    $PluginVersion = (Get-Content $PkgJson -Raw | ConvertFrom-Json).version
  } catch {}
}

# Windows 下 opencode 配置目录: ~/.config/opencode/(xdg-basedir 在 Windows 走 POSIX fallback)
$ConfigDir = Join-Path $env:USERPROFILE '.config\opencode'
$ConfigJsonc = Join-Path $ConfigDir 'opencode.jsonc'

Write-Host ""
Write-Host "DeskFox claude-code plugin 安装器" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# ---------- Step 1: 检查 plugin dist ----------
if (-not (Test-Path $DistPath)) {
  Write-Host "[ERROR] 找不到 plugin build 产物: $DistPath" -ForegroundColor Red
  Write-Host "请先在 plugin 目录运行: bun install ; bun run build" -ForegroundColor Yellow
  exit 1
}
Write-Host "[1/4] plugin dist OK: $DistPath" -ForegroundColor Green

# ---------- Step 2: 探测 claude.exe ----------
function Test-ClaudeExe([string]$exe) {
  if (-not $exe) { return $false }
  if (-not (Test-Path $exe)) { return $false }
  try {
    $null = & $exe --version 2>&1
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

$candidates = New-Object System.Collections.Generic.List[string]

# where claude (PATH 中)
try {
  $whereOut = & where.exe claude 2>$null
  if ($LASTEXITCODE -eq 0 -and $whereOut) {
    foreach ($line in ($whereOut -split "`n")) {
      $t = $line.Trim()
      if ($t) { $candidates.Add($t) | Out-Null }
    }
  }
} catch {}

# 常见安装位置兜底
# Anthropic 官方 native installer (https://claude.ai/install.ps1) — 装到 ~/.local/bin/.
# 已知 bug: native installer 不自动加 PATH (anthropics/claude-code#21365), 即使 user 已配好 claude
# 也可能因 PATH 没刷新让 where claude 漏掉. 此条专门救这种 user.
$candidates.Add((Join-Path $env:USERPROFILE '.local\bin\claude.exe')) | Out-Null
$candidates.Add((Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\claude.exe')) | Out-Null
$candidates.Add((Join-Path $env:APPDATA 'npm\claude.cmd')) | Out-Null
$candidates.Add((Join-Path $env:APPDATA 'npm\claude.exe')) | Out-Null
$candidates.Add((Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe')) | Out-Null

$claudePath = $null
foreach ($c in $candidates) {
  if (Test-ClaudeExe $c) {
    $claudePath = $c
    break
  }
}

if (-not $claudePath) {
  Write-Host "[2/4] 未找到 claude.exe,请手动输入路径" -ForegroundColor Yellow
  Write-Host "      参考:Claude Code CLI 安装后通常在 winget Links / npm global 下" -ForegroundColor DarkGray
  while ($true) {
    $userInput = Read-Host "请输入 claude.exe 完整路径(直接回车退出)"
    if (-not $userInput) {
      Write-Host "已取消安装。" -ForegroundColor Yellow
      exit 1
    }
    $userInput = $userInput.Trim().Trim('"').Trim("'")
    if (Test-ClaudeExe $userInput) {
      $claudePath = $userInput
      break
    }
    Write-Host "  X 路径无效或 claude --version 失败,请重试" -ForegroundColor Red
  }
}

Write-Host "[2/4] claude CLI: $claudePath" -ForegroundColor Green

# ---------- Step 3: 写入配置 ----------
if (-not (Test-Path $ConfigDir)) {
  New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}

# 备份现有 config
if (Test-Path $ConfigJsonc) {
  $bak = "$ConfigJsonc.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
  Copy-Item $ConfigJsonc $bak
  Write-Host "      备份原 config -> $(Split-Path $bak -Leaf)" -ForegroundColor DarkGray
}

# 构造 claude-code provider 节
$pluginUrl = "file:///" + $DistPath.Replace('\', '/')

$claudeCodeProvider = [PSCustomObject]@{
  npm = $pluginUrl
  name = "Claude Code (订阅)"
  models = [PSCustomObject]@{
    sonnet = [PSCustomObject]@{
      name = "Claude Sonnet (via Claude Code)"
      attachment = $true
      reasoning = $true
      tool_call = $true
      modalities = [PSCustomObject]@{ input = @("text", "image"); output = @("text") }
      limit = [PSCustomObject]@{ context = 1000000; output = 16384 }
    }
    opus = [PSCustomObject]@{
      name = "Claude Opus (via Claude Code)"
      attachment = $true
      reasoning = $true
      tool_call = $true
      modalities = [PSCustomObject]@{ input = @("text", "image"); output = @("text") }
      limit = [PSCustomObject]@{ context = 1000000; output = 16384 }
    }
    fable = [PSCustomObject]@{
      name = "Claude Fable 5 (via Claude Code)"
      attachment = $true
      reasoning = $true
      tool_call = $true
      modalities = [PSCustomObject]@{ input = @("text", "image"); output = @("text") }
      limit = [PSCustomObject]@{ context = 1000000; output = 16384 }
    }
    haiku = [PSCustomObject]@{
      name = "Claude Haiku (via Claude Code)"
      attachment = $true
      reasoning = $false
      tool_call = $true
      modalities = [PSCustomObject]@{ input = @("text", "image"); output = @("text") }
      limit = [PSCustomObject]@{ context = 200000; output = 8192 }
    }
  }
  options = [PSCustomObject]@{ cliPath = $claudePath }
}

# 读取或新建 config 对象
$cfgObj = $null
if (Test-Path $ConfigJsonc) {
  $rawText = Get-Content $ConfigJsonc -Raw -Encoding UTF8
  if ($rawText -and $rawText.Trim()) {
    try {
      $cfgObj = $rawText | ConvertFrom-Json -ErrorAction Stop
    } catch {
      Write-Host ""
      Write-Host "[ERROR] config 解析失败(可能含 // JSONC 注释或语法错误):" -ForegroundColor Red
      Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
      Write-Host ""
      Write-Host "请手动在 $ConfigJsonc 的 provider 节里加入下面这块:" -ForegroundColor Yellow
      Write-Host ""
      $snippet = $claudeCodeProvider | ConvertTo-Json -Depth 32
      $snippet = [Regex]::Replace($snippet, '\\u([0-9a-fA-F]{4})', { param($m) [char][int]("0x" + $m.Groups[1].Value) })
      Write-Host "  `"claude-code`": $snippet" -ForegroundColor Cyan
      Write-Host ""
      exit 1
    }
  }
}

if (-not $cfgObj) {
  $cfgObj = [PSCustomObject]@{
    '$schema' = "https://opencode.ai/config.json"
    provider = [PSCustomObject]@{}
  }
}

# 确保 provider 节存在
$hasProvider = $cfgObj.PSObject.Properties.Name -contains 'provider'
if (-not $hasProvider -or -not $cfgObj.provider) {
  $cfgObj | Add-Member -MemberType NoteProperty -Name 'provider' -Value ([PSCustomObject]@{}) -Force
}

# 写入 / 替换 claude-code 节
$cfgObj.provider | Add-Member -MemberType NoteProperty -Name 'claude-code' -Value $claudeCodeProvider -Force

# 序列化 + 解码 unicode escape(让中文可读)
$json = $cfgObj | ConvertTo-Json -Depth 32
$json = [Regex]::Replace($json, '\\u([0-9a-fA-F]{4})', { param($m) [char][int]("0x" + $m.Groups[1].Value) })

# UTF-8 no BOM 写出(避免 jsonc 解析器对 BOM 敏感)
[System.IO.File]::WriteAllText($ConfigJsonc, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "[3/4] config 已更新: $ConfigJsonc" -ForegroundColor Green

# ---------- Step 4: 完成 ----------
Write-Host ""
Write-Host "[4/4] 安装完成  (claude-code plugin v$PluginVersion)" -ForegroundColor Green
Write-Host ""
Write-Host "下一步:" -ForegroundColor Cyan
Write-Host "  1. 完全退出 DeskFox(任务栏右键退出,确保 sidecar opencode-cli 也关掉)"
Write-Host "  2. 重启 DeskFox"
Write-Host "  3. 模型选择器看到 'Claude Code (订阅)',选 Claude Sonnet/Opus/Fable/Haiku 任一即可"
Write-Host "     (Fable 5 需要订阅计划已开放该模型,claude CLI 里 /model 能看到 fable 即可用)"
Write-Host ""
Write-Host "如以后 claude.exe 移位置或要换路径,重跑此脚本即可。" -ForegroundColor DarkGray
Write-Host ""
