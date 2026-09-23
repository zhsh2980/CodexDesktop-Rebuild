<#
.SYNOPSIS
  安装 / 升级 Codex 桌面版（免安装压缩包 -> 按版本分目录安装，无需管理员权限）。

.DESCRIPTION
  把解压后的目录（含 ChatGPT.exe、resources\app.asar 等）复制到安装根目录下、以版本号命名的
  子文件夹（默认 %LOCALAPPDATA%\Programs\CodexApp\Codex-win-x64-<应用版本>），创建/切换开始菜单、
  桌面（以及已固定到任务栏的）快捷方式，并在当前用户注册表里登记"已安装的应用"卸载项。
  全程只写当前用户范围，不需要管理员权限。

  标记文件约定（与本机的商店包更新工具共用，便于互相识别对方装的版本）：
    - 复制期间：<版本目录>\.codexupdater-installing
    - 成功后：  <版本目录>\.codexupdater-installed.json

  每个版本各占一个文件夹，互不覆盖；升级不会重命名/删除旧版本文件夹（除非显式加 -CleanOld
  且满足清理条件）；安装/升级失败时只回滚本次新建的文件夹，不触碰任何旧版本。

  用户数据在 %APPDATA%\Codex 和 %USERPROFILE%\.codex，本脚本不会读取或修改它们。

.PARAMETER InstallRoot      安装根目录，默认 %LOCALAPPDATA%\Programs\CodexApp；每个版本是它下面的子文件夹
.PARAMETER LegacyDir        旧版（固定路径、不带版本号）安装目录，默认 %LOCALAPPDATA%\Programs\Codex；仅用于结尾提示迁移，不会改动它
.PARAMETER Source           解压后的根目录，默认脚本所在目录
.PARAMETER StartMenuDir     开始菜单 Programs 目录（放 Codex.lnk / 更新 Codex.lnk）
.PARAMETER DesktopDir       桌面目录
.PARAMETER TaskbarDir       任务栏固定项目录，默认 %APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar
.PARAMETER NoDesktopShortcut  不创建桌面快捷方式
.PARAMETER SkipRegistry     不写"已安装的应用"卸载项
.PARAMETER RegistryRoot     卸载项所在注册表根，默认 HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall
.PARAMETER ClassesRoot      -CleanStale 扫描的注册表根，默认 HKCU:\Software\Classes
.PARAMETER BackupDir        -CleanStale 备份 .reg 的保存目录，默认当前用户桌面
.PARAMETER NoLaunch         安装完成后不启动
.PARAMETER Force            不询问，直接关闭正在运行的 Codex；对已安装且自检通过的版本也强制清空重装
.PARAMETER Reinstall        即使目标版本已安装且自检通过，也强制清空重装（同 -Force 的重装语义）
.PARAMETER CleanStale       清理旧版本遗留的无效注册表项和快捷方式（会先备份并确认）
.PARAMETER CleanOld         安装成功后删除 root 下"有标记、版本更低、无进程占用、无快捷方式引用"的旧版本文件夹（默认关闭）
.PARAMETER Yes              所有询问都视为"是"（包括关闭正在运行的实例）
.PARAMETER ReleaseTag       本次安装对应的 GitHub 发布 tag（如 v26.915.4065.0），由 update.ps1 传入，写进 .codexupdater-installed.json
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\CodexApp'),
    [string]$LegacyDir = (Join-Path $env:LOCALAPPDATA 'Programs\Codex'),
    [string]$Source,
    [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
    [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
    [string]$TaskbarDir = (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
    [switch]$NoDesktopShortcut,
    [switch]$SkipRegistry,
    [string]$RegistryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    [string]$ClassesRoot = 'HKCU:\Software\Classes',
    [string]$BackupDir = [Environment]::GetFolderPath('Desktop'),
    [switch]$NoLaunch,
    [switch]$Force,
    [switch]$Reinstall,
    [switch]$CleanStale,
    [switch]$CleanOld,
    [switch]$Yes,
    [string]$ReleaseTag
)

$ErrorActionPreference = 'Stop'
$script:ToolVersion = 'installer-2'

# 注意：PowerShell 5.1 里带 [CmdletBinding()] 时 param 默认值中的 $PSScriptRoot 为空，所以在这里补默认值
if ([string]::IsNullOrEmpty($Source)) { $Source = $PSScriptRoot }

# ---------------------------------------------------------------------------
# 通用函数
# ---------------------------------------------------------------------------
function Write-Step([string]$Message) { Write-Host ''; Write-Host ('==> ' + $Message) -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host ('    [OK] ' + $Message) -ForegroundColor Green }
function Write-Info([string]$Message) { Write-Host ('    ' + $Message) }
function Write-Warn([string]$Message) { Write-Host ('    [警告] ' + $Message) -ForegroundColor Yellow }

# 把 8.3 短名（如 C:\Users\LONGUS~1.NAM）展开成长名。
# 进程的可执行文件路径、快捷方式读回来的目标都是长名；如果安装根目录是短名写法（%TEMP% 在用户名较长时常见），
# 直接按字符串前缀比较就会对不上：检测不到正在运行的 Codex、改写不了任务栏固定项、清理旧版本时误判没有快捷方式引用。
# 路径里没有 ~ 时直接原样返回（不编译 P/Invoke，零开销）；路径尾部还不存在时（安装根目录可能还没建），
# 先展开最深的已存在祖先，再把不存在的部分拼回去。
function ConvertTo-LongPath([string]$Path) {
    if ([string]::IsNullOrEmpty($Path) -or $Path.IndexOf('~') -lt 0) { return $Path }
    try {
        if (-not ('CodexInstaller.LongPath' -as [type])) {
            Add-Type -Namespace CodexInstaller -Name LongPath -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetLongPathName(string shortPath, System.Text.StringBuilder longPath, uint bufferLength);'
        }
        $head = $Path
        $tail = ''
        while ($head -and -not (Test-Path -LiteralPath $head)) {
            $leaf = Split-Path -Leaf $head
            if ($tail) { $tail = Join-Path $leaf $tail } else { $tail = $leaf }
            $head = Split-Path -Parent $head
        }
        if (-not $head) { return $Path }
        $sb = New-Object System.Text.StringBuilder 1024
        $n = [CodexInstaller.LongPath]::GetLongPathName($head, $sb, [uint32]$sb.Capacity)
        if ($n -eq 0 -or $n -gt $sb.Capacity) { return $Path }
        $long = $sb.ToString()
        if ($tail) { return (Join-Path $long $tail) }
        return $long
    } catch {
        return $Path
    }
}

# 相对 PowerShell 当前位置解析为绝对路径，展开 8.3 短名，并去掉末尾反斜杠
function Resolve-FullPath([string]$Path) {
    $p = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $p = ConvertTo-LongPath $p
    if ($p.Length -gt 3) { $p = $p.TrimEnd('\') }
    return $p
}

function Confirm-Action([string]$Prompt, [bool]$DefaultYes = $true) {
    if ($Yes) { return $true }
    if ($DefaultYes) { $suffix = '[Y/n]' } else { $suffix = '[y/N]' }
    $ans = Read-Host ($Prompt + ' ' + $suffix)
    if ([string]::IsNullOrWhiteSpace($ans)) { return $DefaultYes }
    return ($ans.Trim() -match '^(y|yes|是)$')
}

# 让当前进程的工作目录离开安装目录，否则无法重命名/删除该目录
function Set-SafeLocation {
    try {
        Set-Location -LiteralPath $env:TEMP
        [Environment]::CurrentDirectory = $env:TEMP
    } catch { }
}

# 可执行文件位于指定目录之下的所有进程
function Get-ProcessesUnder([string]$Dir) {
    $prefix = (ConvertTo-LongPath $Dir).TrimEnd('\') + '\'
    $result = @()
    $cimOk = $false
    try {
        $result = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
            Where-Object { $_.ExecutablePath -and (ConvertTo-LongPath $_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
        $cimOk = $true
    } catch { }
    if (-not $cimOk) {
        # CIM 模块不可用时（例如 PSModulePath 异常）退回到纯 .NET 枚举
        foreach ($p in [Diagnostics.Process]::GetProcesses()) {
            $path = $null
            try { $path = $p.MainModule.FileName } catch { continue }
            if ($path -and (ConvertTo-LongPath $path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                $result += [pscustomobject]@{ ProcessId = $p.Id; Name = ($p.ProcessName + '.exe'); ExecutablePath = $path }
            }
        }
    }
    return $result
}

# 先礼貌关闭窗口，再强制结束；返回是否全部退出
function Stop-ProcessesUnder([string]$Dir, [int]$TimeoutSec = 20) {
    $procs = @(Get-ProcessesUnder $Dir)
    if ($procs.Count -eq 0) { return $true }
    foreach ($p in $procs) {
        try {
            $gp = Get-Process -Id $p.ProcessId -ErrorAction Stop
            if ($gp.MainWindowHandle -ne [IntPtr]::Zero) { [void]$gp.CloseMainWindow() }
        } catch { }
    }
    $deadline = (Get-Date).AddSeconds(4)
    while ((Get-Date) -lt $deadline -and @(Get-ProcessesUnder $Dir).Count -gt 0) { Start-Sleep -Milliseconds 400 }
    foreach ($p in @(Get-ProcessesUnder $Dir)) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (@(Get-ProcessesUnder $Dir).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (@(Get-ProcessesUnder $Dir).Count -eq 0)
}

function Remove-DirRobust([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    for ($i = 1; $i -le 3; $i++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return $true
        } catch {
            Start-Sleep -Milliseconds 800
        }
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
    }
    try { & cmd.exe /c ('rd /s /q "' + $Path + '"') 2>&1 | Out-Null } catch { }
    return (-not (Test-Path -LiteralPath $Path))
}

# robocopy 退出码 0~7 都算成功，>=8 表示有失败
function Invoke-Robocopy([string]$Src, [string]$Dst) {
    $rcArgs = @($Src, $Dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1', '/MT:8')
    & robocopy.exe @rcArgs | Out-Null
    return $LASTEXITCODE
}

function New-Shortcut([string]$LnkPath, [string]$Target, [string]$WorkDir, [string]$Description, [string]$IconLocation) {
    $dir = Split-Path -Parent $LnkPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $ws = New-Object -ComObject WScript.Shell
    try {
        $lnk = $ws.CreateShortcut($LnkPath)
        $lnk.TargetPath = $Target
        $lnk.WorkingDirectory = $WorkDir
        $lnk.Description = $Description
        $lnk.IconLocation = $IconLocation
        $lnk.Save()
    } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($ws)
    }
}

function Get-ShortcutTarget([string]$LnkPath) {
    $ws = New-Object -ComObject WScript.Shell
    try { return $ws.CreateShortcut($LnkPath).TargetPath } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($ws) }
}

# 从 LocalServer32 默认值（可能带引号和参数）里取出 exe 路径
function Get-ExePathFromCommand([string]$Command) {
    if ([string]::IsNullOrWhiteSpace($Command)) { return $null }
    $c = $Command.Trim()
    if ($c.StartsWith('"')) {
        $end = $c.IndexOf('"', 1)
        if ($end -gt 1) { return $c.Substring(1, $end - 1) }
        return $c.TrimStart('"')
    }
    $m = [regex]::Match($c, '^(.+?\.exe)(\s|$)', 'IgnoreCase')
    if ($m.Success) { return $m.Groups[1].Value }
    return $c
}

# 只有在"盘符可访问但文件不存在"时才认为是确认无效（盘符不在线时不能算无效）
function Test-PathConfirmedMissing([string]$Path) {
    try {
        if (-not [IO.Path]::IsPathRooted($Path)) { return $false }
        $root = [IO.Path]::GetPathRoot($Path)
        if ([string]::IsNullOrEmpty($root)) { return $false }
        if (-not (Test-Path -LiteralPath $root)) { return $false }
        return (-not (Test-Path -LiteralPath $Path))
    } catch { return $false }
}

function Get-DirSizeKB([string]$Dir) {
    $sum = (Get-ChildItem -LiteralPath $Dir -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0 }
    return [int][Math]::Min([Math]::Ceiling($sum / 1KB), [int]::MaxValue)
}

# 版本比较：按点分数字逐段比较。返回 1 (A>B) / 0 / -1 (A<B)。非数字段按 0 处理。
function Compare-CodexVersion([string]$A, [string]$B) {
    $pa = @(([string]$A -replace '^[vV]', '') -split '\.' | ForEach-Object {
            $n = 0L
            $digits = [regex]::Match($_, '^\d+').Value
            if ($digits -and [long]::TryParse($digits, [ref]$n)) { $n } else { 0L }
        })
    $pb = @(([string]$B -replace '^[vV]', '') -split '\.' | ForEach-Object {
            $n = 0L
            $digits = [regex]::Match($_, '^\d+').Value
            if ($digits -and [long]::TryParse($digits, [ref]$n)) { $n } else { 0L }
        })
    $len = [Math]::Max($pa.Count, $pb.Count)
    for ($i = 0; $i -lt $len; $i++) {
        $x = 0L; if ($i -lt $pa.Count) { $x = [long]$pa[$i] }
        $y = 0L; if ($i -lt $pb.Count) { $y = [long]$pb[$i] }
        if ($x -gt $y) { return 1 }
        if ($x -lt $y) { return -1 }
    }
    return 0
}

# 读取版本文件夹的安装标记（.codexupdater-installed.json），不存在/无法解析返回 $null
function Get-InstalledInfo([string]$Dir) {
    $p = Join-Path $Dir '.codexupdater-installed.json'
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try { return ([IO.File]::ReadAllText($p) | ConvertFrom-Json) } catch { return $null }
}

# 写入安装标记（UTF-8 无 BOM），字段与本机的商店包更新工具共用同一套约定
function Write-InstalledMarker([string]$Dir, [string]$AppVersion, [string]$MsixVersion, [string]$ZipName, [string]$Tag) {
    $obj = [ordered]@{
        appVersion  = $AppVersion
        msixVersion = $(if ($MsixVersion) { $MsixVersion } else { $null })
        installedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        toolVersion = $script:ToolVersion
        source      = 'CodexDesktop-Rebuild installer'
        flavor      = 'portable-zip'
        releaseTag  = $(if ($Tag) { $Tag } else { $null })
        zipName     = $(if ($ZipName) { $ZipName } else { $null })
    }
    $json = $obj | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $Dir '.codexupdater-installed.json'), $json, (New-Object Text.UTF8Encoding $false))
}

# 安装后自检：关键文件是否存在、有没有 %XX 异常路径、内置 CLI 能否正常运行
# 支持环境变量 CODEX_INSTALLER_TEST_FAULT=selfcheck 强制判定失败（测试用）
function Test-SelfCheck([string]$Dir) {
    $problems = 0
    foreach ($rel in @('ChatGPT.exe', 'resources\app.asar', 'resources\codex.exe')) {
        if (Test-Path -LiteralPath (Join-Path $Dir $rel)) { Write-Ok ('存在：' + $rel) }
        else { Write-Warn ('缺少文件：' + $rel); $problems++ }
    }
    $badNames = @(Get-ChildItem -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '%[0-9A-Fa-f]{2}' })
    if ($badNames.Count -gt 0) {
        Write-Warn ('目录里发现 ' + $badNames.Count + ' 个含 %XX 的路径（形如 %40oai，旧包的致命问题，应用可能无法加载依赖）：')
        foreach ($b in $badNames | Select-Object -First 5) { Write-Info ('  ' + $b.FullName) }
        $problems++
    } else {
        Write-Ok '没有含 %XX 的异常路径。'
    }
    $cliExe = Join-Path $Dir 'resources\codex.exe'
    if (Test-Path -LiteralPath $cliExe) {
        try {
            $psi = New-Object Diagnostics.ProcessStartInfo
            $psi.FileName = $cliExe
            $psi.Arguments = '--version'
            $psi.UseShellExecute = $false
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.CreateNoWindow = $true
            $proc = [Diagnostics.Process]::Start($psi)
            $outTask = $proc.StandardOutput.ReadToEndAsync()
            $errTask = $proc.StandardError.ReadToEndAsync()
            if ($proc.WaitForExit(15000)) {
                $verText = ($outTask.Result + ' ' + $errTask.Result).Trim()
                if ($proc.ExitCode -eq 0 -and $verText) { Write-Ok ('内置 CLI 版本：' + $verText) }
                else { Write-Warn ('codex.exe --version 返回异常（退出码 ' + $proc.ExitCode + '）：' + $verText); $problems++ }
            } else {
                try { $proc.Kill() } catch { }
                Write-Warn 'codex.exe --version 15 秒内没有返回。'
                $problems++
            }
        } catch {
            Write-Warn ('无法运行 codex.exe --version：' + $_.Exception.Message)
            $problems++
        }
    }
    if ($env:CODEX_INSTALLER_TEST_FAULT -eq 'selfcheck') {
        Write-Warn '（测试注入的故障：自检失败）'
        $problems++
    }
    return [pscustomobject]@{ Ok = ($problems -eq 0); Problems = $problems }
}

# ---------------------------------------------------------------------------
# 清理旧版本遗留（-CleanStale）
# ---------------------------------------------------------------------------
function Invoke-CleanStale {
    Write-Step '清理旧版本遗留的无效项（-CleanStale）'

    # (a) 注册表：CLSID\*\LocalServer32 指向不存在的 ChatGPT.exe / Codex.exe
    $staleKeys = New-Object System.Collections.ArrayList
    $clsidRoot = Join-Path $ClassesRoot 'CLSID'
    if (Test-Path -LiteralPath $clsidRoot) {
        foreach ($k in @(Get-ChildItem -LiteralPath $clsidRoot -ErrorAction SilentlyContinue)) {
            $val = $null
            $ls = $null
            try { $ls = $k.OpenSubKey('LocalServer32') } catch { $ls = $null }
            if ($null -eq $ls) { continue }
            try { $val = $ls.GetValue('') } catch { $val = $null } finally { $ls.Close() }
            $exe = Get-ExePathFromCommand ([string]$val)
            if ([string]::IsNullOrEmpty($exe)) { continue }
            try {
                $leaf = Split-Path -Leaf $exe
                $parentName = Split-Path -Leaf (Split-Path -Parent $exe)
            } catch { continue }
            if ($leaf -notmatch '^(ChatGPT|Codex)\.exe$') { continue }
            if ($parentName -notlike 'Codex*') { continue }
            if (-not (Test-PathConfirmedMissing $exe)) { continue }
            [void]$staleKeys.Add([pscustomobject]@{ Name = $k.Name; Exe = $exe })
        }
    } else {
        Write-Info ('注册表根不存在，跳过：' + $clsidRoot)
    }

    # (b) 快捷方式：指向不存在的文件，且路径含 Codex-win-x64 或以 Codex.exe / ChatGPT.exe 结尾
    $staleLnks = New-Object System.Collections.ArrayList
    $scanDirs = @()
    if ($StartMenuDir -and (Test-Path -LiteralPath $StartMenuDir)) { $scanDirs += , @($StartMenuDir, $true) }
    if ($DesktopDir -and (Test-Path -LiteralPath $DesktopDir)) { $scanDirs += , @($DesktopDir, $false) }
    foreach ($sd in $scanDirs) {
        $dir = $sd[0]
        if ($sd[1]) { $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue) }
        else { $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -ErrorAction SilentlyContinue) }
        foreach ($f in $files) {
            $t = $null
            try { $t = Get-ShortcutTarget $f.FullName } catch { continue }
            if ([string]::IsNullOrWhiteSpace($t)) { continue }
            $looksLikeCodex = ($t -like '*Codex-win-x64*') -or ($t -match '\\(Codex|ChatGPT)\.exe$')
            if (-not $looksLikeCodex) { continue }
            if (-not (Test-PathConfirmedMissing $t)) { continue }
            [void]$staleLnks.Add([pscustomobject]@{ Path = $f.FullName; Target = $t })
        }
    }

    if ($staleKeys.Count -eq 0 -and $staleLnks.Count -eq 0) {
        Write-Ok '没有发现需要清理的残留项。'
        return
    }

    Write-Info ('发现无效注册表项 ' + $staleKeys.Count + ' 个，无效快捷方式 ' + $staleLnks.Count + ' 个：')
    foreach ($s in $staleKeys | Select-Object -First 15) { Write-Info ('  [注册表] ' + ($s.Name -replace '^.*\\CLSID\\', 'CLSID\') + '  ->  ' + $s.Exe) }
    if ($staleKeys.Count -gt 15) { Write-Info ('  ... 其余 ' + ($staleKeys.Count - 15) + ' 个注册表项省略') }
    foreach ($s in $staleLnks) { Write-Info ('  [快捷方式] ' + $s.Path + '  ->  ' + $s.Target) }

    if (-not (Confirm-Action '确认清理以上残留项？（清理前会先导出 .reg 备份）' $false)) {
        Write-Info '已跳过清理。'
        return
    }

    if ($staleKeys.Count -gt 0) {
        if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $bakFile = Join-Path $BackupDir ('Codex-清理备份-' + $stamp + '.reg')
        $sb = New-Object System.Text.StringBuilder
        $first = $true
        foreach ($s in $staleKeys) {
            $tmp = Join-Path $env:TEMP ('codex-reg-' + [Guid]::NewGuid().ToString('N') + '.reg')
            & reg.exe export $s.Name $tmp /y 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmp)) {
                throw ('导出注册表备份失败，已中止清理（未删除任何东西）：' + $s.Name)
            }
            $text = [IO.File]::ReadAllText($tmp, [Text.Encoding]::Unicode)
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            if (-not $first) { $text = $text -replace '^\uFEFF?Windows Registry Editor Version 5\.00\r?\n\r?\n?', '' }
            [void]$sb.Append($text)
            $first = $false
        }
        [IO.File]::WriteAllText($bakFile, $sb.ToString(), [Text.Encoding]::Unicode)
        Write-Ok ('已导出备份（双击该 .reg 可还原）：' + $bakFile)

        $done = 0
        foreach ($s in $staleKeys) {
            & reg.exe delete $s.Name /f 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $done++ } else { Write-Warn ('删除失败：' + $s.Name) }
        }
        Write-Ok ('已删除无效注册表项 ' + $done + ' / ' + $staleKeys.Count + ' 个')
    }

    $doneLnk = 0
    foreach ($s in $staleLnks) {
        try { Remove-Item -LiteralPath $s.Path -Force -ErrorAction Stop; $doneLnk++ } catch { Write-Warn ('删除快捷方式失败：' + $s.Path) }
    }
    if ($staleLnks.Count -gt 0) { Write-Ok ('已删除无效快捷方式 ' + $doneLnk + ' / ' + $staleLnks.Count + ' 个') }
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
try {
    $InstallRoot = Resolve-FullPath $InstallRoot
    $LegacyDir   = Resolve-FullPath $LegacyDir
    $Source      = Resolve-FullPath $Source
    Set-SafeLocation

    Write-Host ''
    Write-Host 'Codex 安装程序（免管理员，仅写当前用户目录）' -ForegroundColor White

    # ---- 1. 前置检查 ----
    Write-Step '检查安装包'
    if (-not (Test-Path -LiteralPath (Join-Path $Source 'ChatGPT.exe'))) {
        throw ('安装包不完整：在 ' + $Source + ' 里找不到 ChatGPT.exe。请先把 zip 完整解压，再运行本脚本。')
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Source 'resources\app.asar'))) {
        throw ('安装包不完整：在 ' + $Source + ' 里找不到 resources\app.asar。请重新下载并完整解压 zip。')
    }

    # BUILD-INFO.json 字段：version（=appVersion，兼容旧字段）、appVersion（asar 版本）、msixVersion（商店包版本）、zipName、cli.used
    # 任何字段缺失都容错为空；appVersion 依次回退 version、msixVersion；三者都没有则拒绝安装
    $appVersion = $null
    $msixVersion = $null
    $zipName = $null
    $buildInfo = $null
    $biPath = Join-Path $Source 'BUILD-INFO.json'
    if (Test-Path -LiteralPath $biPath) {
        try {
            $buildInfo = [IO.File]::ReadAllText($biPath) | ConvertFrom-Json
            if ($buildInfo.appVersion)  { $appVersion = [string]$buildInfo.appVersion }
            if ($buildInfo.msixVersion) { $msixVersion = [string]$buildInfo.msixVersion }
            if ($buildInfo.zipName)     { $zipName = [string]$buildInfo.zipName }
            if ((-not $appVersion) -and $buildInfo.version) { $appVersion = [string]$buildInfo.version }
        } catch {
            Write-Warn ('BUILD-INFO.json 无法解析：' + $_.Exception.Message)
        }
    } else {
        Write-Warn '没有找到 BUILD-INFO.json。'
    }
    if (-not $appVersion) { $appVersion = $msixVersion }
    if (-not $appVersion) {
        throw ('无法确定版本号：BUILD-INFO.json 里没有 appVersion / version / msixVersion 任何一个字段，已拒绝安装（避免装出一个版本号不明的文件夹）。请确认 zip 是否完整解压，或联系发布者补上 BUILD-INFO.json。')
    }

    $versionDirName = 'Codex-win-x64-' + $appVersion
    $targetDir = Join-Path $InstallRoot $versionDirName
    $installingMarker = Join-Path $targetDir '.codexupdater-installing'
    $installedMarker  = Join-Path $targetDir '.codexupdater-installed.json'

    Write-Ok ('待安装版本：应用版本 ' + $appVersion + $(if ($msixVersion) { '（商店包版本 ' + $msixVersion + '）' } else { '' }) + $(if ($ReleaseTag) { '，发布 tag ' + $ReleaseTag } else { '' }))
    Write-Info ('源目录：' + $Source)
    Write-Info ('安装根目录：' + $InstallRoot)
    Write-Info ('目标版本目录：' + $targetDir)

    $inPlace = ($Source.TrimEnd('\') -ieq $targetDir.TrimEnd('\'))
    if (-not $inPlace) {
        if ($targetDir.StartsWith($Source + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw '目标版本目录位于源目录内部，无法安装。请换一个 -InstallRoot，或把 zip 解压到别处。'
        }
        if ($Source.StartsWith($targetDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw '源目录位于目标版本目录内部，无法安装。请把 zip 解压到别处再运行。'
        }
    } else {
        Write-Info '源目录就是目标版本目录本身（解压即安装）。'
    }

    # ---- 2. 决定本次安装模式 ----
    $mode = $null
    if (-not (Test-Path -LiteralPath $targetDir)) {
        $mode = 'fresh'
    } elseif ($inPlace) {
        $mode = 'in-place'
    } elseif (Test-Path -LiteralPath $installingMarker) {
        $mode = 'resume'
        Write-Info '发现上次未完成的安装现场（.codexupdater-installing 标记），将清理后重新安装。'
    } elseif (Test-Path -LiteralPath $installedMarker) {
        Write-Step '目标版本目录已存在，正在自检'
        $chk = Test-SelfCheck $targetDir
        if ($chk.Ok -and -not ($Force -or $Reinstall)) {
            $mode = 'already-installed'
        } else {
            if (-not $chk.Ok) { Write-Warn ('自检未通过（' + $chk.Problems + ' 个问题），将清理后重新安装。') }
            else { Write-Info '已指定 -Force/-Reinstall，将清理后重新安装。' }
            $mode = 'reinstall'
        }
    } else {
        throw ('目标目录已存在，但不是本工具创建的（没有找到安装标记 .codexupdater-installed.json 或 .codexupdater-installing）：' + "`n    " + $targetDir + "`n    为避免误删你的数据，已中止且未做任何改动。请重命名/清空这个目录，或改用 -InstallRoot 指定别的安装根目录。")
    }

    # ---- 3. 检查正在运行的 Codex（只在需要新建/覆盖文件夹时才检查并关闭） ----
    if ($mode -eq 'fresh' -or $mode -eq 'resume' -or $mode -eq 'reinstall') {
        Write-Step '检查正在运行的 Codex（安装根目录下所有版本）'
        $running = @(Get-ProcessesUnder $InstallRoot)
        if ($running.Count -gt 0) {
            $names = ($running | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', '
            Write-Warn ('检测到 ' + $running.Count + ' 个正在运行的进程（' + $names + '），需要先关闭。')
            if (-not ($Force -or $Yes)) {
                if (-not (Confirm-Action '现在关闭它们并继续安装？' $true)) { throw '用户取消：请先手动退出 Codex 再重试。' }
            }
            if (-not (Stop-ProcessesUnder $InstallRoot 20)) {
                throw '无法关闭正在运行的 Codex 进程（等待 20 秒仍未退出）。请手动结束任务管理器里的 ChatGPT.exe / codex.exe 后重试。'
            }
            Write-Ok '已关闭正在运行的实例。'
        } else {
            Write-Ok '没有正在运行的实例。'
        }
    }

    # ---- 4. 按模式复制/校验 ----
    if ($mode -eq 'resume' -or $mode -eq 'reinstall') {
        Write-Step '清理目标版本目录'
        if (-not (Remove-DirRobust $targetDir)) { throw ('无法清理目标版本目录：' + $targetDir + '，请手动删除后重试。') }
        Write-Ok '已清理。'
    }

    if ($mode -eq 'fresh' -or $mode -eq 'resume' -or $mode -eq 'reinstall') {
        Write-Step '复制文件'
        if (-not (Test-Path -LiteralPath $InstallRoot)) { New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null }
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        [IO.File]::WriteAllText($installingMarker, (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'), (New-Object Text.UTF8Encoding $false))

        $rc = Invoke-Robocopy $Source $targetDir
        if ($env:CODEX_INSTALLER_TEST_FAULT -eq 'copy') { Write-Warn '（测试注入的故障：复制失败）'; $rc = 16 }
        if ($rc -ge 8) {
            [void](Remove-DirRobust $targetDir)
            throw ('复制文件失败（robocopy 退出码 ' + $rc + '，可能是磁盘空间不足或文件被占用）。已放弃本次安装：本次新建的目录已清理，其它版本和快捷方式均未受影响。')
        }
        Write-Ok ('文件复制完成（robocopy 退出码 ' + $rc + '）')

        Write-Step '安装后自检'
        $chk = Test-SelfCheck $targetDir
        if (-not $chk.Ok) {
            [void](Remove-DirRobust $targetDir)
            throw ('安装后自检失败（' + $chk.Problems + ' 个问题），已自动回滚：本次新建的目录已删除，其它版本和快捷方式均未受影响。')
        }
        Remove-Item -LiteralPath $installingMarker -Force -ErrorAction SilentlyContinue
        Write-InstalledMarker $targetDir $appVersion $msixVersion $zipName $ReleaseTag
        Write-Ok '自检通过，已写入安装标记。'
    } elseif ($mode -eq 'in-place') {
        Write-Step '解压即安装：跳过复制，直接自检'
        $hadInstalling = Test-Path -LiteralPath $installingMarker
        if (-not $hadInstalling) {
            try { [IO.File]::WriteAllText($installingMarker, (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'), (New-Object Text.UTF8Encoding $false)) } catch { }
        }
        $chk = Test-SelfCheck $targetDir
        if (-not $chk.Ok) {
            Remove-Item -LiteralPath $installingMarker -Force -ErrorAction SilentlyContinue
            throw ('自检失败（' + $chk.Problems + ' 个问题）。这个目录就是你解压出来的源目录本身，本工具不会删除它，也不会写入安装标记。请检查 zip 是否完整解压后重试。')
        }
        Remove-Item -LiteralPath $installingMarker -Force -ErrorAction SilentlyContinue
        Write-InstalledMarker $targetDir $appVersion $msixVersion $zipName $ReleaseTag
        Write-Ok '自检通过，已写入安装标记。'
    } else {
        # already-installed
        Write-Ok ('目标版本已安装且自检通过，跳过复制：' + $targetDir)
    }

    $exePath = Join-Path $targetDir 'ChatGPT.exe'

    # ---- 5. 快捷方式 ----
    Write-Step '创建/切换快捷方式'
    $startLnk = Join-Path $StartMenuDir 'Codex.lnk'
    $updateLnk = Join-Path $StartMenuDir '更新 Codex.lnk'
    $desktopLnk = Join-Path $DesktopDir 'Codex.lnk'
    try {
        New-Shortcut $startLnk $exePath $targetDir 'OpenAI Codex' ($exePath + ',0')
        Write-Ok ('开始菜单：' + $startLnk)
        $updateCmd = Join-Path $targetDir 'Update-Codex.cmd'
        if (Test-Path -LiteralPath $updateCmd) {
            New-Shortcut $updateLnk $updateCmd $targetDir '检查并更新 Codex' ($exePath + ',0')
            Write-Ok ('开始菜单（更新）：' + $updateLnk)
        }
        if (-not $NoDesktopShortcut) {
            New-Shortcut $desktopLnk $exePath $targetDir 'OpenAI Codex' ($exePath + ',0')
            Write-Ok ('桌面：' + $desktopLnk)
        } else {
            Write-Info '已跳过桌面快捷方式（-NoDesktopShortcut）。'
        }
    } catch {
        Write-Warn ('创建快捷方式失败（不影响使用，可直接运行 ChatGPT.exe）：' + $_.Exception.Message)
    }

    # 任务栏：只原地改写已经存在、指向安装根目录下某个版本 ChatGPT.exe 的固定项；不新增固定、不写注册表
    $taskbarUpdated = 0
    if ($TaskbarDir -and (Test-Path -LiteralPath $TaskbarDir)) {
        foreach ($lnk in @(Get-ChildItem -LiteralPath $TaskbarDir -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
            $t = $null
            try { $t = ConvertTo-LongPath (Get-ShortcutTarget $lnk.FullName) } catch { continue }
            if ([string]::IsNullOrWhiteSpace($t)) { continue }
            if ($t.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and ($t -imatch '\\ChatGPT\.exe$')) {
                try {
                    New-Shortcut $lnk.FullName $exePath $targetDir 'OpenAI Codex' ($exePath + ',0')
                    Write-Ok ('任务栏（已固定，原地改写）：' + $lnk.FullName)
                    $taskbarUpdated++
                } catch { Write-Warn ('改写任务栏快捷方式失败：' + $lnk.FullName + '：' + $_.Exception.Message) }
            }
        }
    }
    if ($taskbarUpdated -eq 0) {
        Write-Info '没有发现已固定到任务栏的 Codex 快捷方式，不会自动固定；如需要，可在 Codex.lnk 或 ChatGPT.exe 上右键选择"固定到任务栏"。'
    }

    # ---- 6. 注册"已安装的应用" ----
    if (-not $SkipRegistry) {
        Write-Step '登记到"已安装的应用"'
        try {
            $key = Join-Path $RegistryRoot 'Codex-Portable'
            New-Item -Path $key -Force | Out-Null
            $uninstallCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $targetDir 'uninstall.ps1') + '" -InstallRoot "' + $InstallRoot + '"'
            $sizeKB = Get-DirSizeKB $targetDir
            Set-ItemProperty -LiteralPath $key -Name 'DisplayName'     -Value 'Codex'
            Set-ItemProperty -LiteralPath $key -Name 'DisplayVersion'  -Value $appVersion
            Set-ItemProperty -LiteralPath $key -Name 'Publisher'       -Value 'OpenAI（社区重打包）'
            Set-ItemProperty -LiteralPath $key -Name 'InstallLocation' -Value $targetDir
            Set-ItemProperty -LiteralPath $key -Name 'DisplayIcon'     -Value ($exePath + ',0')
            Set-ItemProperty -LiteralPath $key -Name 'UninstallString' -Value $uninstallCmd
            Set-ItemProperty -LiteralPath $key -Name 'NoModify'        -Value 1 -Type DWord
            Set-ItemProperty -LiteralPath $key -Name 'NoRepair'        -Value 1 -Type DWord
            Set-ItemProperty -LiteralPath $key -Name 'EstimatedSize'   -Value $sizeKB -Type DWord
            Write-Ok ('已写入：' + $key)
        } catch {
            Write-Warn ('写入卸载项失败（不影响使用，只是不会出现在设置->应用里）：' + $_.Exception.Message)
        }
    }

    # ---- 7. 清理残留（-CleanStale） ----
    if ($CleanStale) {
        try { Invoke-CleanStale } catch { Write-Warn ('清理残留时出错：' + $_.Exception.Message) }
    }

    # ---- 8. 清理旧版本（-CleanOld） ----
    if ($CleanOld) {
        Write-Step '清理旧版本（-CleanOld）'
        try {
            $managedTargets = New-Object System.Collections.Generic.List[string]
            foreach ($p in @($startLnk, $updateLnk, $desktopLnk)) {
                if (Test-Path -LiteralPath $p) { try { [void]$managedTargets.Add((Get-ShortcutTarget $p)) } catch { } }
            }
            if ($TaskbarDir -and (Test-Path -LiteralPath $TaskbarDir)) {
                foreach ($lnk in @(Get-ChildItem -LiteralPath $TaskbarDir -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
                    try { [void]$managedTargets.Add((Get-ShortcutTarget $lnk.FullName)) } catch { }
                }
            }
            $candidates = @(Get-ChildItem -LiteralPath $InstallRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'Codex-win-x64-*' -and $_.FullName -ine $targetDir })
            $removed = 0
            foreach ($c in $candidates) {
                $info = Get-InstalledInfo $c.FullName
                if ((-not $info) -or (-not $info.appVersion)) { Write-Info ('跳过（没有安装标记）：' + $c.FullName); continue }
                if ((Compare-CodexVersion ([string]$info.appVersion) $appVersion) -ge 0) { Write-Info ('跳过（版本不低于本次安装）：' + $c.FullName); continue }
                $procs = @(Get-ProcessesUnder $c.FullName)
                if ($procs.Count -gt 0) { Write-Info ('跳过（有正在运行的进程）：' + $c.FullName); continue }
                $referenced = $false
                foreach ($mt in $managedTargets) {
                    if ($mt -and (ConvertTo-LongPath $mt).StartsWith($c.FullName + '\', [StringComparison]::OrdinalIgnoreCase)) { $referenced = $true; break }
                }
                if ($referenced) { Write-Info ('跳过（仍被快捷方式引用）：' + $c.FullName); continue }
                if (Remove-DirRobust $c.FullName) { Write-Ok ('已删除旧版本：' + $c.FullName); $removed++ }
                else { Write-Warn ('删除失败：' + $c.FullName) }
            }
            if ($removed -eq 0) { Write-Info '没有需要清理的旧版本。' }
        } catch {
            Write-Warn ('清理旧版本时出错：' + $_.Exception.Message)
        }
    }

    # ---- 9. 旧固定目录迁移提示 ----
    if (Test-Path -LiteralPath (Join-Path $LegacyDir 'install-info.json')) {
        Write-Warn ('检测到旧版本仍安装在固定目录（旧模型）：' + $LegacyDir)
        Write-Info ('本工具不会改动它；确认新版本运行正常后，可以手动删除该目录，或运行 ' + (Join-Path $LegacyDir 'uninstall.ps1'))
    }

    # ---- 10. 启动 ----
    if (-not $NoLaunch) {
        Write-Step '启动 Codex'
        try { Start-Process -FilePath $exePath -WorkingDirectory $targetDir; Write-Ok '已启动。' }
        catch { Write-Warn ('启动失败：' + $_.Exception.Message) }
    }

    # ---- 11. 摘要 ----
    Write-Host ''
    Write-Host '==================== 安装完成 ====================' -ForegroundColor Green
    Write-Host ('  版本      ：应用版本 ' + $appVersion + $(if ($msixVersion) { '（商店包版本 ' + $msixVersion + '）' } else { '' }))
    if ($ReleaseTag) { Write-Host ('  发布 tag  ：' + $ReleaseTag) }
    Write-Host ('  安装位置  ：' + $targetDir)
    Write-Host ('  安装根目录：' + $InstallRoot)
    Write-Host ('  开始菜单  ：' + $startLnk)
    if (-not $NoDesktopShortcut) { Write-Host ('  桌面快捷  ：' + $desktopLnk) }
    Write-Host '  用户数据  ：%APPDATA%\Codex 与 %USERPROFILE%\.codex（升级/卸载默认不会动它们）'
    Write-Host '  更新      ：运行版本目录里的 Update-Codex.cmd，或开始菜单里的「更新 Codex」'
    Write-Host '  卸载      ：设置 -> 应用 -> 已安装的应用 -> Codex，或运行版本目录里的 uninstall.ps1'
    Write-Host '==================================================' -ForegroundColor Green
    exit 0
} catch {
    Write-Host ''
    Write-Host ('[错误] ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
