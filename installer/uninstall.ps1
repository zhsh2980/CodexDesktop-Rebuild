<#
.SYNOPSIS
  卸载 Codex 桌面版（免安装压缩包安装的版本，按版本分目录模型）。

.DESCRIPTION
  关闭安装根目录下所有版本正在运行的实例，删除指向安装根目录的开始菜单/桌面/任务栏快捷方式和
  "已安装的应用"卸载项；然后询问是否删除安装根目录下"带安装标记"的版本文件夹
  （.codexupdater-installed.json）。**没有安装标记的文件夹永远不会被删除**（可能是你自己放的东西）。

  本脚本绝不会触碰用户数据：%APPDATA%\Codex 和 %USERPROFILE%\.codex 任何情况下都不会被删除。

.PARAMETER InstallRoot   安装根目录。默认：脚本所在目录若是一个带安装标记的 Codex-win-x64-* 文件夹，
                         则取其父目录；否则 %LOCALAPPDATA%\Programs\CodexApp
.PARAMETER StartMenuDir  开始菜单 Programs 目录
.PARAMETER DesktopDir    桌面目录
.PARAMETER TaskbarDir    任务栏固定项目录，默认 %APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar
.PARAMETER RegistryRoot  卸载项所在注册表根
.PARAMETER KeepFiles     只清理快捷方式和卸载项，保留安装根目录下所有版本文件夹
.PARAMETER Yes           不询问
.PARAMETER NoPause       结束时不等待按键
#>
[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$StartMenuDir = [Environment]::GetFolderPath('Programs'),
    [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
    [string]$TaskbarDir = (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
    [string]$RegistryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    [switch]$KeepFiles,
    [switch]$Yes,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

# 默认安装根目录：脚本自身所在目录若是一个带安装标记的 Codex-win-x64-* 文件夹，root = 其父目录；否则固定默认值
# 注意：PowerShell 5.1 里带 [CmdletBinding()] 时 param 默认值中的 $PSScriptRoot 为空，所以在这里补默认值
if ([string]::IsNullOrEmpty($InstallRoot)) {
    $detected = $null
    if ($PSScriptRoot) {
        $selfName = Split-Path -Leaf $PSScriptRoot
        if ($selfName -like 'Codex-win-x64-*' -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.codexupdater-installed.json'))) {
            $detected = Split-Path -Parent $PSScriptRoot
        }
    }
    if ($detected) { $InstallRoot = $detected }
    else { $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\CodexApp' }
}

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

function Set-SafeLocation {
    try {
        Set-Location -LiteralPath $env:TEMP
        [Environment]::CurrentDirectory = $env:TEMP
    } catch { }
}

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

function Get-ShortcutTarget([string]$LnkPath) {
    $ws = New-Object -ComObject WScript.Shell
    try { return $ws.CreateShortcut($LnkPath).TargetPath } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($ws) }
}

# 只删除目标确实指向安装根目录（任意版本）里文件的快捷方式
function Remove-OurShortcut([string]$LnkPath, [string]$Root) {
    if (-not (Test-Path -LiteralPath $LnkPath)) { return }
    $target = $null
    try { $target = ConvertTo-LongPath (Get-ShortcutTarget $LnkPath) } catch { }
    if ($target -and $target.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        try { Remove-Item -LiteralPath $LnkPath -Force -ErrorAction Stop; Write-Ok ('已删除快捷方式：' + $LnkPath) }
        catch { Write-Warn ('删除快捷方式失败：' + $LnkPath + '（' + $_.Exception.Message + '）') }
    } else {
        Write-Info ('跳过（不是指向本安装根目录的快捷方式）：' + $LnkPath + '  ->  ' + $target)
    }
}

# 读取版本文件夹的安装标记，不存在/无法解析返回 $null
function Get-InstalledInfo([string]$Dir) {
    $p = Join-Path $Dir '.codexupdater-installed.json'
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try { return ([IO.File]::ReadAllText($p) | ConvertFrom-Json) } catch { return $null }
}

function Wait-ForKey {
    if ($Yes -or $NoPause) { return }
    try { [void](Read-Host '按回车键退出') } catch { }
}

try {
    $InstallRoot = Resolve-FullPath $InstallRoot
    Set-SafeLocation

    Write-Host ''
    Write-Host 'Codex 卸载程序' -ForegroundColor White
    Write-Info ('安装根目录：' + $InstallRoot)
    Write-Info '用户数据（%APPDATA%\Codex、%USERPROFILE%\.codex）本脚本任何情况下都不会删除。'

    if ($InstallRoot.Length -le 3) {
        throw ('安装根目录 ' + $InstallRoot + ' 是磁盘根目录，为安全起见已中止。')
    }

    # 找出安装根目录下带安装标记的版本文件夹
    $markedDirs = @()
    $unmarkedDirs = @()
    if (Test-Path -LiteralPath $InstallRoot) {
        foreach ($d in @(Get-ChildItem -LiteralPath $InstallRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Codex-win-x64-*' })) {
            $info = Get-InstalledInfo $d.FullName
            if ($info) { $markedDirs += $d.FullName } else { $unmarkedDirs += $d.FullName }
        }
    }

    if ($markedDirs.Count -eq 0) {
        Write-Info '安装根目录下没有找到带安装标记的版本文件夹。'
    } else {
        Write-Info ('找到 ' + $markedDirs.Count + ' 个带安装标记的版本文件夹：')
        foreach ($d in $markedDirs) { Write-Info ('  ' + $d) }
    }
    if ($unmarkedDirs.Count -gt 0) {
        Write-Info ('另外发现 ' + $unmarkedDirs.Count + ' 个没有安装标记的文件夹，将保留不动：')
        foreach ($d in $unmarkedDirs) { Write-Info ('  ' + $d) }
    }

    if (-not (Confirm-Action '确认卸载 Codex？' $true)) {
        Write-Info '已取消。'
        Wait-ForKey
        exit 0
    }

    # 1. 关闭正在运行的实例（安装根目录下所有版本）
    Write-Step '关闭正在运行的 Codex'
    if (Test-Path -LiteralPath $InstallRoot) {
        if (Stop-ProcessesUnder $InstallRoot 20) { Write-Ok '没有残留进程。' }
        else { throw '无法关闭正在运行的 Codex 进程，请手动结束任务管理器里的 ChatGPT.exe / codex.exe 后重试。' }
    }

    # 2. 快捷方式（只删除确实指向安装根目录的）
    Write-Step '删除快捷方式'
    Remove-OurShortcut (Join-Path $StartMenuDir 'Codex.lnk') $InstallRoot
    Remove-OurShortcut (Join-Path $StartMenuDir '更新 Codex.lnk') $InstallRoot
    Remove-OurShortcut (Join-Path $DesktopDir 'Codex.lnk') $InstallRoot
    if ($TaskbarDir -and (Test-Path -LiteralPath $TaskbarDir)) {
        foreach ($lnk in @(Get-ChildItem -LiteralPath $TaskbarDir -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
            Remove-OurShortcut $lnk.FullName $InstallRoot
        }
    }

    # 3. 卸载项
    Write-Step '删除"已安装的应用"卸载项'
    $key = Join-Path $RegistryRoot 'Codex-Portable'
    if (Test-Path -LiteralPath $key) {
        Remove-Item -LiteralPath $key -Recurse -Force
        Write-Ok ('已删除：' + $key)
    } else {
        Write-Info '卸载项不存在，跳过。'
    }

    # 4. 版本文件夹（只删除带安装标记的；-KeepFiles 时全部保留）
    Write-Step '删除版本文件夹'
    if ($KeepFiles) {
        Write-Info '已指定 -KeepFiles，保留安装根目录下所有版本文件夹。'
    } elseif ($markedDirs.Count -eq 0) {
        Write-Info '没有需要删除的版本文件夹。'
    } else {
        foreach ($d in $markedDirs) {
            if (Remove-DirRobust $d) { Write-Ok ('已删除：' + $d) }
            else { Write-Warn ('无法删除 ' + $d + '（可能有文件被占用），已跳过。') }
        }
    }
    if ($unmarkedDirs.Count -gt 0) {
        Write-Info ('没有安装标记的文件夹已保留（不会被本脚本删除）：' + ($unmarkedDirs -join '; '))
    }

    Write-Host ''
    Write-Host '==================== 卸载完成 ====================' -ForegroundColor Green
    Write-Host '  用户数据已保留（%APPDATA%\Codex、%USERPROFILE%\.codex），重新安装后可继续使用。'
    Write-Host '==================================================' -ForegroundColor Green
    Wait-ForKey
    exit 0
} catch {
    Write-Host ''
    Write-Host ('[错误] ' + $_.Exception.Message) -ForegroundColor Red
    Wait-ForKey
    exit 1
}
