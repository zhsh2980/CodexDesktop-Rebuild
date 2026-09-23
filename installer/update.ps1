<#
.SYNOPSIS
  检查并更新 Codex 桌面版：从 GitHub Releases 下载最新 zip，校验后调用 install.ps1 原地升级。

.DESCRIPTION
  * 版本检查不使用需要认证的 GitHub API：读取 https://github.com/<Repo>/releases/latest 的 302 跳转得到 tag；
    再读 releases/expanded_assets/<tag> 页面得到真实的 zip 文件名（tag 用的是商店包版本，zip 文件名用的是应用版本，
    两者不同，所以不能拼文件名）；两条路都失败才回退到 GitHub API 的 assets 列表。
  * "是否有新版本"优先比较 install-info.json 的 releaseTag 与最新 tag；没有则比较 msixVersion；都没有视为"未知，建议更新"。
  * 下载支持断点续传、每条线路最多重试 3 次；线路顺序：配置的代理 -> 直连 -> 系统代理。127.0.0.1/localhost 一律直连。
  * 有 SHA256SUMS.txt（否则用发布页显示的 sha256 摘要）时校验 SHA-256，不匹配则删除并报错。
  * 升级不会动用户数据（%APPDATA%\Codex、%USERPROFILE%\.codex）。

.PARAMETER Repo          GitHub 仓库，默认 zhsh2980/CodexDesktop-Rebuild
.PARAMETER Proxy         代理，例如 http://10.0.0.1:8080；默认自动用环境变量 HTTPS_PROXY/HTTP_PROXY，再系统代理，再直连。
                 写 direct（或 none）表示强制直连、不用任何代理。
.PARAMETER CheckOnly     只比较并显示版本，不下载
.PARAMETER InstallRoot   安装根目录（每个版本是它下面的 Codex-win-x64-<版本> 子文件夹）。默认：脚本自身所在目录若是一个
                 带安装标记的 Codex-win-x64-* 文件夹，则取其父目录；否则 %LOCALAPPDATA%\Programs\CodexApp
.PARAMETER InstallDir    旧参数，仅为兼容保留。等于旧的固定安装目录时会被忽略（按新模型走默认 -InstallRoot）；
                 传入其它路径时会被当作 -InstallRoot 使用，并给出提示。新脚本请直接用 -InstallRoot
.PARAMETER Yes           不询问（有新版本就更新；更新后直接启动，除非同时指定 -NoLaunch）
.PARAMETER KeepDownload  更新完成后保留下载的 zip
.PARAMETER NoLaunch      更新完成后不询问、不启动
.PARAMETER CleanOld      更新成功后删除 root 下"有标记、版本更低、无进程占用、无快捷方式引用"的旧版本文件夹（透传给 install.ps1）
.PARAMETER BaseUrl       网站根地址，默认 https://github.com（一般不用改，测试用）
.PARAMETER ApiUrl        API 根地址，默认 https://api.github.com（一般不用改，测试用）
.PARAMETER WorkDir       下载与解压的工作目录，默认 %TEMP%\CodexUpdate
.PARAMETER StartMenuDir / DesktopDir / TaskbarDir / RegistryRoot / NoDesktopShortcut / SkipRegistry
                 只有显式指定时才原样转交给 install.ps1（默认值与 install.ps1 相同，一般不用指定，测试用）
#>
[CmdletBinding()]
param(
    [string]$Repo = 'zhsh2980/CodexDesktop-Rebuild',
    [string]$Proxy,
    [switch]$CheckOnly,
    [string]$InstallRoot,
    [string]$InstallDir,
    [switch]$Yes,
    [switch]$KeepDownload,
    [switch]$NoLaunch,
    [switch]$CleanOld,
    [string]$BaseUrl = 'https://github.com',
    [string]$ApiUrl = 'https://api.github.com',
    [string]$WorkDir = (Join-Path $env:TEMP 'CodexUpdate'),
    [string]$StartMenuDir,
    [string]$DesktopDir,
    [string]$TaskbarDir,
    [string]$RegistryRoot,
    [switch]$NoDesktopShortcut,
    [switch]$SkipRegistry
)

$ErrorActionPreference = 'Stop'
$script:BoundParams = $PSBoundParameters   # 函数内的 $PSBoundParameters 是函数自己的，这里先存一份脚本级的

# 确定安装根目录，优先级：显式 -InstallRoot > 脚本自身位置识别 > 兼容旧参数 -InstallDir > 默认新根目录
# 注意：PowerShell 5.1 里带 [CmdletBinding()] 时 param 默认值中的 $PSScriptRoot 为空，所以在这里补默认值
if ([string]::IsNullOrEmpty($InstallRoot)) {
    $detectedRoot = $null
    if ($PSScriptRoot) {
        $selfName = Split-Path -Leaf $PSScriptRoot
        if ($selfName -like 'Codex-win-x64-*' -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.codexupdater-installed.json'))) {
            $detectedRoot = Split-Path -Parent $PSScriptRoot
        }
    }
    if ($detectedRoot) {
        $InstallRoot = $detectedRoot
    } elseif (-not [string]::IsNullOrEmpty($InstallDir)) {
        $legacyDefault = Join-Path $env:LOCALAPPDATA 'Programs\Codex'
        $legacyResolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($legacyDefault).TrimEnd('\')
        $givenResolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir).TrimEnd('\')
        if ($givenResolved -ieq $legacyResolved) {
            Write-Host '    检测到 -InstallDir 指向旧的固定安装目录，已按新模型改用默认安装根目录（旧版本不受影响）。'
        } else {
            Write-Host '    -InstallDir 是旧参数，已当作 -InstallRoot 使用（建议改用 -InstallRoot）。'
            $InstallRoot = $InstallDir
        }
    }
}
if ([string]::IsNullOrEmpty($InstallRoot)) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\CodexApp' }

# PowerShell 5.1 默认可能只启用 TLS 1.0/1.1，GitHub 需要 TLS 1.2+
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor ([Net.SecurityProtocolType]12288) } catch { }
[Net.ServicePointManager]::Expect100Continue = $false

$script:Connected = $false
$script:LastGoodRoute = $null
$script:LastHttpCode = 0
$script:InteractiveConsole = ($Host.Name -eq 'ConsoleHost') -and (-not [Console]::IsOutputRedirected)

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

# 让进程工作目录离开安装目录（否则安装脚本无法重命名该目录）
function Set-SafeLocation {
    try {
        Set-Location -LiteralPath $env:TEMP
        [Environment]::CurrentDirectory = $env:TEMP
    } catch { }
}

function Remove-DirRobust([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    for ($i = 1; $i -le 3; $i++) {
        try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop; return $true } catch { Start-Sleep -Milliseconds 800 }
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
    }
    try { & cmd.exe /c ('rd /s /q "' + $Path + '"') 2>&1 | Out-Null } catch { }
    return (-not (Test-Path -LiteralPath $Path))
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

# ---------------------------------------------------------------------------
# 网络：线路（代理）选择、请求、断点续传
# ---------------------------------------------------------------------------
function Test-ForceDirect {
    return (-not [string]::IsNullOrWhiteSpace($Proxy)) -and ($Proxy.Trim() -match '^(direct|none|off)(://)?$')
}

function Get-ConfiguredProxyUrl {
    if (Test-ForceDirect) { return $null }
    $p = $Proxy
    if ([string]::IsNullOrWhiteSpace($p)) {
        foreach ($n in @('HTTPS_PROXY', 'HTTP_PROXY')) {
            $v = [Environment]::GetEnvironmentVariable($n)
            if (-not [string]::IsNullOrWhiteSpace($v)) { $p = $v; break }
        }
    }
    if ([string]::IsNullOrWhiteSpace($p)) { return $null }
    $p = $p.Trim()
    if ($p -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $p = 'http://' + $p }
    return $p
}

# 返回按顺序尝试的线路列表：@{ Name; Proxy(IWebProxy，$null=直连) }
# 有配置代理：配置代理 -> 直连 -> 系统代理；没有：系统代理(如果有) -> 直连
function Get-Routes([uri]$Uri) {
    $routes = New-Object System.Collections.ArrayList
    # 本机地址（127.0.0.1 / localhost / ::1）永远直连；-Proxy direct 也只走直连
    if ($Uri.IsLoopback) { return @([pscustomobject]@{ Name = '本机地址（直连）'; Proxy = $null }) }
    if (Test-ForceDirect) { return @([pscustomobject]@{ Name = '直连（-Proxy direct）'; Proxy = $null }) }
    $cfg = Get-ConfiguredProxyUrl
    $sysProxy = $null
    $sysUri = $null
    try {
        $sp = [Net.WebRequest]::GetSystemWebProxy()
        $sp.Credentials = [Net.CredentialCache]::DefaultCredentials
        if (-not $sp.IsBypassed($Uri)) { $sysProxy = $sp; $sysUri = $sp.GetProxy($Uri) }
    } catch { }

    if ($cfg) {
        $wp = New-Object Net.WebProxy($cfg, $true)
        $wp.UseDefaultCredentials = $true
        [void]$routes.Add([pscustomobject]@{ Name = ('配置的代理 ' + ($cfg -replace '//[^/@]*@', '//')); Proxy = $wp })
        [void]$routes.Add([pscustomobject]@{ Name = '直连（不使用代理）'; Proxy = $null })
        if ($sysProxy -and $sysUri -and ($sysUri.AbsoluteUri.TrimEnd('/') -ine ([uri]$cfg).AbsoluteUri.TrimEnd('/'))) {
            [void]$routes.Add([pscustomobject]@{ Name = ('系统代理 ' + $sysUri.Authority); Proxy = $sysProxy })
        }
    } else {
        if ($sysProxy -and $sysUri) { [void]$routes.Add([pscustomobject]@{ Name = ('系统代理 ' + $sysUri.Authority); Proxy = $sysProxy }) }
        [void]$routes.Add([pscustomobject]@{ Name = '直连（不使用代理）'; Proxy = $null })
    }

    # 把上次成功的线路放到最前面
    if ($script:LastGoodRoute) {
        $good = @($routes | Where-Object { $_.Name -eq $script:LastGoodRoute })
        if ($good.Count -gt 0) {
            $rest = @($routes | Where-Object { $_.Name -ne $script:LastGoodRoute })
            return @($good[0]) + $rest
        }
    }
    return @($routes)
}

function New-WebRequest([string]$Url, $Route, [int]$TimeoutMs = 30000) {
    $req = [Net.HttpWebRequest][Net.WebRequest]::Create($Url)
    $req.UserAgent = 'CodexInstaller/1.0 (PowerShell)'
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy = $Route.Proxy
    return $req
}

function Get-WebEx($Ex) {
    $e = $Ex
    while ($e) {
        if ($e -is [Net.WebException]) { return $e }
        $e = $e.InnerException
    }
    return $null
}

function Get-HttpStatusCode($Ex) {
    $we = Get-WebEx $Ex
    if ($we -and $we.Response) { return [int]$we.Response.StatusCode }
    return 0
}

function Get-InnerMessage($Ex) {
    $e = $Ex
    while ($e.InnerException) { $e = $e.InnerException }
    return $e.Message
}

# 依次用各条线路执行 $Action（参数：线路对象）。HTTP 4xx（除 407/408/429）视为确定性错误，不再换线路。
function Invoke-WithRoutes([string]$Url, [scriptblock]$Action, [int]$MaxAttempts, [string]$What) {
    $routes = @(Get-Routes ([uri]$Url))
    $lastMsg = ''
    foreach ($route in $routes) {
        Write-Info ('[' + $What + '] 线路：' + $route.Name)
        for ($a = 1; $a -le $MaxAttempts; $a++) {
            $script:Connected = $false
            try {
                $r = & $Action $route
                $script:LastGoodRoute = $route.Name
                return $r
            } catch {
                $code = Get-HttpStatusCode $_.Exception
                $lastMsg = Get-InnerMessage $_.Exception
                if ($code -ge 400 -and $code -lt 500 -and $code -ne 407 -and $code -ne 408 -and $code -ne 429) {
                    $script:LastHttpCode = $code
                    throw ('HTTP ' + $code + '：' + $lastMsg)
                }
                Write-Warn ('第 ' + $a + '/' + $MaxAttempts + ' 次失败（' + $route.Name + '）：' + $lastMsg)
                if ($code -eq 407) { break }
                if ((-not $script:Connected) -and $code -eq 0) { break }
                if ($a -lt $MaxAttempts) { Start-Sleep -Seconds (2 * $a) }
            }
        }
    }
    $script:LastHttpCode = 0
    $hint = ''
    if ($lastMsg -match 'certificate|SSL|TLS|secure channel') { $hint = ' 提示：证书/TLS 错误通常说明这条线路上的 HTTPS 被网络设备拦截，请用 -Proxy 指定能正常访问 GitHub 的代理。' }
    throw ('所有线路都失败了。最后一次错误：' + $lastMsg + $hint)
}

function Get-TextFromUrl([string]$Url, [string]$What, [string]$Accept = '*/*') {
    return Invoke-WithRoutes $Url {
        param($route)
        $req = New-WebRequest $Url $route
        $req.Accept = $Accept
        $resp = $req.GetResponse()
        $script:Connected = $true
        try {
            $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
            $sr.ReadToEnd()
        } finally { $resp.Close() }
    } 2 $What
}

# 解析 releases/expanded_assets/<tag> 返回的 HTML 片段：取出 /releases/download/<tag>/<文件名> 链接，
# 以及紧随其后的 sha256:<64位十六进制> 摘要（GitHub 会在资产旁边显示）。处理 HTML 实体和 URL 转义。
function ConvertFrom-AssetsHtml([string]$Html, [string]$Tag) {
    $assets = @()
    $ms = [regex]::Matches($Html, 'href="([^"]*/releases/download/[^"]+)"')
    for ($i = 0; $i -lt $ms.Count; $i++) {
        $href = [Net.WebUtility]::HtmlDecode($ms[$i].Groups[1].Value)
        $m = [regex]::Match($href, '/releases/download/([^/]+)/([^/?#]+)$')
        if (-not $m.Success) { continue }
        if ([Uri]::UnescapeDataString($m.Groups[1].Value) -ine $Tag) { continue }
        $name = [Uri]::UnescapeDataString($m.Groups[2].Value)
        $endPos = $Html.Length
        if ($i + 1 -lt $ms.Count) { $endPos = $ms[$i + 1].Index }
        $segment = $Html.Substring($ms[$i].Index, $endPos - $ms[$i].Index)
        $sha = $null
        $sm = [regex]::Match($segment, 'sha256:([0-9a-fA-F]{64})')
        if ($sm.Success) { $sha = $sm.Groups[1].Value.ToLowerInvariant() }
        $url = $href
        if ($href.StartsWith('/')) { $url = $BaseUrl.TrimEnd('/') + $href }
        $assets += [pscustomobject]@{ Name = $name; Url = $url; Sha256 = $sha }
    }
    return $assets
}

function ConvertFrom-ApiAssets($Release) {
    $assets = @()
    foreach ($a in @($Release.assets)) {
        if (-not $a.name) { continue }
        $sha = $null
        if ($a.digest -and ([string]$a.digest) -match '^sha256:([0-9a-fA-F]{64})$') { $sha = $Matches[1].ToLowerInvariant() }
        $assets += [pscustomobject]@{ Name = [string]$a.name; Url = [string]$a.browser_download_url; Sha256 = $sha }
    }
    return $assets
}

function Get-ApiRelease([string]$ApiEndpoint, [string]$What) {
    try {
        $json = Get-TextFromUrl $ApiEndpoint $What 'application/vnd.github+json'
        return ($json | ConvertFrom-Json)
    } catch {
        if ($script:LastHttpCode -eq 404) { throw ('仓库 ' + $Repo + ' 不存在或还没有发布任何版本（HTTP 404）。') }
        if ($script:LastHttpCode -eq 403) { throw 'GitHub API 访问被限流（HTTP 403），请稍后再试，或用 -Proxy 换一个出口。' }
        throw ('无法获取发布信息：' + $_.Exception.Message + ' 请检查网络；公司网络请用 -Proxy http://代理地址:端口 指定代理。')
    }
}

# 获取最新发布。返回 Tag / TagVersion / ZipName / ZipUrl / AppVersion / SumsUrl / Sha256
# 注意：tag 用的是商店包版本（如 v26.908.9136.0），zip 文件名用的是应用版本（如 Codex-win-x64-26.908.70816.zip），
# 两者不同，所以 zip 文件名一定要从发布页/API 的资产列表里读，不能用 tag 拼。
function Get-LatestRelease {
    $tag = $null
    $assets = @()
    $apiTried = $false

    # 1) tag：读 releases/latest 的 302 Location（不用需要认证的 API，不会被限流）
    $url = $BaseUrl.TrimEnd('/') + '/' + $Repo + '/releases/latest'
    try {
        $loc = Invoke-WithRoutes $url {
            param($route)
            $req = New-WebRequest $url $route 20000
            $req.AllowAutoRedirect = $false
            $req.Method = 'GET'
            $resp = $req.GetResponse()
            $script:Connected = $true
            try { [string]$resp.Headers['Location'] } finally { $resp.Close() }
        } 2 '获取最新版本'
        $m = [regex]::Match([string]$loc, '/releases/tag/([^/?#]+)')
        if ($m.Success) { $tag = [Uri]::UnescapeDataString($m.Groups[1].Value) }
        else { Write-Warn ('跳转地址里没有版本号（' + $loc + '），改用 GitHub API 查询。') }
    } catch {
        Write-Warn ('读取 /releases/latest 跳转失败：' + $_.Exception.Message + '；改用 GitHub API 查询。')
    }

    # 1b) 回退：API（同时拿到 tag 和资产列表）
    if (-not $tag) {
        $apiTried = $true
        $obj = Get-ApiRelease ($ApiUrl.TrimEnd('/') + '/repos/' + $Repo + '/releases/latest') '通过 API 获取最新版本'
        $tag = [string]$obj.tag_name
        $assets = @(ConvertFrom-ApiAssets $obj)
    }
    if (-not $tag) { throw '没有找到最新发布的版本号。' }

    # 2) 资产：读 releases/expanded_assets/<tag>（同样不需要认证）
    if ($assets.Count -eq 0) {
        $eaUrl = $BaseUrl.TrimEnd('/') + '/' + $Repo + '/releases/expanded_assets/' + [Uri]::EscapeDataString($tag)
        try {
            $html = Get-TextFromUrl $eaUrl '读取发布页资产列表' 'text/html, */*'
            $assets = @(ConvertFrom-AssetsHtml $html $tag)
        } catch {
            Write-Warn ('读取发布页资产列表失败：' + $_.Exception.Message)
        }
    }

    # 2b) 回退：API 按 tag 取资产（不再用 tag 版本去猜文件名）
    if (@($assets | Where-Object { $_.Name -like 'Codex-win-x64-*.zip' }).Count -eq 0 -and -not $apiTried) {
        Write-Info '发布页里没有解析到安装包，改用 GitHub API 读取资产列表。'
        $obj = Get-ApiRelease ($ApiUrl.TrimEnd('/') + '/repos/' + $Repo + '/releases/tags/' + [Uri]::EscapeDataString($tag)) '通过 API 获取资产列表'
        $assets = @(ConvertFrom-ApiAssets $obj)
    }

    $zip = @($assets | Where-Object { $_.Name -like 'Codex-win-x64-*.zip' } | Sort-Object Name -Descending | Select-Object -First 1)
    if ($zip.Count -eq 0) {
        throw ('发布 ' + $tag + ' 里没有找到 Codex-win-x64-*.zip 安装包（可能还在构建上传中，请稍后再试）。')
    }
    $zipAsset = $zip[0]
    $sums = @($assets | Where-Object { $_.Name -eq 'SHA256SUMS.txt' } | Select-Object -First 1)
    $sumsUrl = $null
    if ($sums.Count -gt 0) { $sumsUrl = $sums[0].Url }
    $appVer = [regex]::Match($zipAsset.Name, '^Codex-win-x64-(.+)\.zip$').Groups[1].Value

    return [pscustomobject]@{
        Tag        = $tag
        TagVersion = ($tag -replace '^[vV]', '')
        ZipName    = [IO.Path]::GetFileName($zipAsset.Name)
        ZipUrl     = $zipAsset.Url
        AppVersion = $appVer
        SumsUrl    = $sumsUrl
        Sha256     = $zipAsset.Sha256
    }
}

# 单次下载尝试（支持 Range 续传）。成功返回 'done' / 'complete'，失败抛异常（.part 文件保留以便续传）。
function Receive-Once([string]$Url, [string]$Part, $Route) {
    $existing = 0L
    if (Test-Path -LiteralPath $Part) { $existing = (Get-Item -LiteralPath $Part).Length }
    $req = New-WebRequest $Url $Route 30000
    if ($existing -gt 0) { $req.AddRange([long]$existing) }

    $resp = $null
    try {
        try {
            $resp = $req.GetResponse()
        } catch {
            $we = Get-WebEx $_.Exception
            $code = Get-HttpStatusCode $_.Exception
            if ($code -eq 416) {
                $script:Connected = $true
                $cr = ''
                try { $cr = [string]$we.Response.Headers['Content-Range'] } catch { }
                try { $we.Response.Close() } catch { }
                $cm = [regex]::Match($cr, '/(\d+)\s*$')
                if ($cm.Success -and ([long]$cm.Groups[1].Value -eq $existing)) { return 'complete' }
                Remove-Item -LiteralPath $Part -Force -ErrorAction SilentlyContinue
                throw '服务器拒绝了续传范围，已丢弃残留文件，将从头重试。'
            }
            throw
        }
        $script:Connected = $true
        $status = [int]$resp.StatusCode
        $offset = 0L
        $mode = [IO.FileMode]::Create
        if ($status -eq 206) {
            $cr = [string]$resp.Headers['Content-Range']
            $cm = [regex]::Match($cr, '^bytes\s+(\d+)-')
            if ($cm.Success -and ([long]$cm.Groups[1].Value -ne $existing)) {
                Remove-Item -LiteralPath $Part -Force -ErrorAction SilentlyContinue
                throw '服务器返回的续传起点不对，已丢弃残留文件，将从头重试。'
            }
            $offset = $existing
            $mode = [IO.FileMode]::Append
            Write-Info ('从 ' + [Math]::Round($existing / 1MB, 1) + ' MB 处继续下载（断点续传）')
        } elseif ($existing -gt 0) {
            Write-Info '服务器不支持断点续传，从头开始下载。'
        }
        $len = $resp.ContentLength
        $total = -1L
        if ($len -ge 0) { $total = $offset + $len }

        $fs = New-Object IO.FileStream($Part, $mode, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $stream = $resp.GetResponseStream()
        try {
            $buf = New-Object byte[] 262144
            $got = 0L
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $lastShow = 0L
            while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
                $fs.Write($buf, 0, $n)
                $got += $n
                $ms = $sw.ElapsedMilliseconds
                $interval = 500
                if (-not $script:InteractiveConsole) { $interval = 5000 }
                if ($ms - $lastShow -ge $interval) {
                    $lastShow = $ms
                    $speed = 0.0
                    if ($ms -gt 0) { $speed = ($got / 1MB) / ($ms / 1000.0) }
                    $doneMB = ($offset + $got) / 1MB
                    if ($total -gt 0) {
                        $line = ('    已下载 {0:N1} MB / {1:N1} MB ({2:N0}%)  {3:N2} MB/s' -f $doneMB, ($total / 1MB), (100.0 * ($offset + $got) / $total), $speed)
                    } else {
                        $line = ('    已下载 {0:N1} MB  {1:N2} MB/s' -f $doneMB, $speed)
                    }
                    if ($script:InteractiveConsole) { [Console]::Write("`r" + $line.PadRight(78)) } else { Write-Host $line }
                }
            }
            $fs.Flush()
        } finally {
            $fs.Close()
            $stream.Close()
        }
        if ($script:InteractiveConsole) { [Console]::Write("`r" + (' ' * 78) + "`r") }
        $finalMB = ($offset + $got) / 1MB
        $secs = [Math]::Max($sw.Elapsed.TotalSeconds, 0.001)
        Write-Info ('本次接收 {0:N1} MB，用时 {1:N0} 秒，平均 {2:N2} MB/s' -f ($got / 1MB), $secs, (($got / 1MB) / $secs))
        if ($total -ge 0 -and ($offset + $got) -ne $total) {
            throw ('连接中断：只收到 ' + [Math]::Round($finalMB, 1) + ' MB，应为 ' + [Math]::Round($total / 1MB, 1) + ' MB。')
        }
        return 'done'
    } finally {
        if ($resp) { $resp.Close() }
    }
}

# 下载到 $Dest；线路 x 重试 x 断点续传。成功后 $Dest 存在。
function Save-FileResumable([string]$Url, [string]$Dest, [string]$What) {
    $part = $Dest + '.part'
    $dir = Split-Path -Parent $Dest
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [void](Invoke-WithRoutes $Url {
            param($route)
            Receive-Once $Url $part $route
        } 3 $What)
    Move-Item -LiteralPath $part -Destination $Dest -Force
}

# 计算文件 SHA-256（小写十六进制）。直接用 .NET，不依赖 Get-FileHash 所在的模块。
function Get-Sha256Hex([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead($Path)
    try { return (($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $fs.Close(); $sha.Dispose() }
}

# 显示用：同时写出应用版本、商店包（tag）版本和发布 tag，避免混淆
function Format-VersionLabel([string]$AppVersion, [string]$MsixVersion, [string]$Tag) {
    $parts = @()
    if ($AppVersion) { $parts += ('应用版本 ' + $AppVersion) }
    if ($MsixVersion) { $parts += ('商店包版本 ' + $MsixVersion) }
    if ($Tag) { $parts += ('tag ' + $Tag) }
    if ($parts.Count -eq 0) { return '版本未知' }
    return ($parts -join '，')
}

# 枚举安装根目录下带安装标记（.codexupdater-installed.json）的版本文件夹
function Get-InstalledVersionFolders([string]$Root) {
    $result = @()
    if (-not (Test-Path -LiteralPath $Root)) { return $result }
    foreach ($d in @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Codex-win-x64-*' })) {
        $mp = Join-Path $d.FullName '.codexupdater-installed.json'
        if (-not (Test-Path -LiteralPath $mp)) { continue }
        $parsed = $null
        try { $parsed = [IO.File]::ReadAllText($mp) | ConvertFrom-Json } catch { continue }
        if (-not $parsed.appVersion) { continue }
        $result += [pscustomobject]@{ Dir = $d.FullName; Info = $parsed }
    }
    return $result
}

function Get-ExpectedHash([string]$SumsText, [string]$FileName) {
    foreach ($line in ($SumsText -split "`r?`n")) {
        $m = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})\s+\*?(.+)$')
        if ($m.Success) {
            $name = $m.Groups[2].Value.Trim()
            if ($name -ieq $FileName -or $name.EndsWith('/' + $FileName) -or $name.EndsWith('\' + $FileName)) { return $m.Groups[1].Value.ToLowerInvariant() }
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
function Start-CodexUpdate {
    $InstallRoot = Resolve-FullPath $InstallRoot
    $WorkDir = Resolve-FullPath $WorkDir
    Set-SafeLocation

    Write-Host ''
    Write-Host 'Codex 更新程序' -ForegroundColor White

    # ---- 1. 已安装版本：root 下带安装标记、appVersion 最高的文件夹 ----
    Write-Step '读取已安装版本'
    $folders = @(Get-InstalledVersionFolders $InstallRoot)
    $current = $null
    foreach ($f in $folders) {
        if (-not $current) { $current = $f; continue }
        if ((Compare-CodexVersion ([string]$f.Info.appVersion) ([string]$current.Info.appVersion)) -gt 0) { $current = $f }
    }
    $info = $null
    $instApp = $null; $instMsix = $null; $instTag = $null
    if ($current) {
        $info = $current.Info
        $instApp = [string]$info.appVersion
        if ($info.msixVersion) { $instMsix = [string]$info.msixVersion }
        if ($info.releaseTag) { $instTag = [string]$info.releaseTag }
        Write-Ok ('已安装：' + (Format-VersionLabel $instApp $instMsix $instTag) + '（' + $current.Dir + '）')
        if ($folders.Count -gt 1) { Write-Info ('安装根目录下共有 ' + $folders.Count + ' 个版本文件夹，以上是其中版本最高的一个。') }
    } else {
        Write-Info ('未在安装根目录（' + $InstallRoot + '）检测到带安装标记的版本，将按全新安装处理。')
    }

    # ---- 2. 最新版本 ----
    Write-Step ('查询最新版本（' + $Repo + '）')
    $cfgProxy = Get-ConfiguredProxyUrl
    if ($cfgProxy) { Write-Info ('已配置代理：' + ($cfgProxy -replace '//[^/@]*@', '//')) }
    elseif (Test-ForceDirect) { Write-Info '已指定 -Proxy direct：强制直连。' }
    $rel = Get-LatestRelease
    $relLabel = Format-VersionLabel $rel.AppVersion $rel.TagVersion $rel.Tag
    Write-Ok ('最新发布：' + $relLabel)
    Write-Info ('安装包：' + $rel.ZipName)

    # ---- 3. 比较 ----
    # 优先比较 releaseTag 与最新 tag；没有 releaseTag 就比较 msixVersion 与 tag 的版本部分；都没有 -> 未知，建议更新
    $known = $false
    $cmp = 0
    if ($info) {
        if ($instTag) { $cmp = Compare-CodexVersion $rel.TagVersion $instTag; $known = $true }
        elseif ($instMsix) { $cmp = Compare-CodexVersion $rel.TagVersion $instMsix; $known = $true }
    }
    if ($info -and $known -and $cmp -le 0) {
        if ($cmp -eq 0) { Write-Host ('已是最新版本（' + (Format-VersionLabel $instApp $instMsix $instTag) + '），无需更新。') -ForegroundColor Green }
        else { Write-Host ('已安装的版本（' + (Format-VersionLabel $instApp $instMsix $instTag) + '）比线上最新发布（' + $rel.Tag + '）还新，无需更新。') -ForegroundColor Green }
        return
    }
    if ($info -and $known) { Write-Host ('发现新版本：' + (Format-VersionLabel $instApp $instMsix $instTag) + '  ->  ' + $relLabel) -ForegroundColor Yellow }
    elseif ($info) { Write-Host ('无法判断已安装的版本对应哪个发布（install-info.json 里没有 releaseTag 和 msixVersion），建议更新一次：' + $relLabel) -ForegroundColor Yellow }
    else { Write-Host ('线上最新发布：' + $relLabel + '（本机尚未安装）') -ForegroundColor Yellow }
    if ($CheckOnly) {
        Write-Info '（-CheckOnly：只检查，不下载。去掉该参数即可更新。）'
        return
    }

    if (-not (Confirm-Action ('下载约 700 MB 并更新到 ' + $rel.Tag + '？更新时会自动关闭正在运行的 Codex。') $true)) {
        Write-Info '已取消。'
        return
    }

    # ---- 4. 下载 ----
    if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    try {
        $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($WorkDir))
        if ($drive.AvailableFreeSpace -lt 3GB) {
            Write-Warn ('临时目录所在磁盘剩余空间只有 ' + [Math]::Round($drive.AvailableFreeSpace / 1GB, 1) + ' GB，解压和安装大约需要 3 GB，可能不够。')
        }
    } catch { }
    $zipPath = Join-Path $WorkDir $rel.ZipName

    # 校验来源：优先 SHA256SUMS.txt；没有则用 GitHub 发布页/API 给出的 sha256 摘要；都没有就跳过并提示
    $expected = $null
    $expectedFrom = $null
    if ($rel.SumsUrl) {
        Write-Step '下载校验文件 SHA256SUMS.txt'
        try {
            $sums = Get-TextFromUrl $rel.SumsUrl '下载 SHA256SUMS.txt'
            $expected = Get-ExpectedHash $sums $rel.ZipName
            if ($expected) { $expectedFrom = 'SHA256SUMS.txt' }
            else { Write-Warn ('SHA256SUMS.txt 里没有 ' + $rel.ZipName + ' 的记录。') }
        } catch {
            if ($script:LastHttpCode -eq 404) { Write-Warn 'SHA256SUMS.txt 下载失败（HTTP 404）。' }
            else { throw }
        }
    }
    if ((-not $expected) -and $rel.Sha256) { $expected = $rel.Sha256; $expectedFrom = 'GitHub 发布页显示的 sha256 摘要' }
    if ($expected) { Write-Ok ('期望的 SHA-256（来自 ' + $expectedFrom + '）：' + $expected) }
    else { Write-Warn '这个发布没有提供 SHA256SUMS.txt，也没有可用的 sha256 摘要，将跳过完整性校验。' }

    # 上次保留的完整 zip：校验通过就直接复用
    $needDownload = $true
    if (Test-Path -LiteralPath $zipPath) {
        if ($expected) {
            Write-Info '发现已下载的 zip，校验中...'
            $h = (Get-Sha256Hex $zipPath)
            if ($h -eq $expected) { $needDownload = $false; Write-Ok '已下载的文件校验通过，直接复用。' }
            else { Remove-Item -LiteralPath $zipPath -Force }
        } else {
            Remove-Item -LiteralPath $zipPath -Force
        }
    }

    if ($needDownload) {
        Write-Step ('下载 ' + $rel.ZipName)
        Write-Info $rel.ZipUrl
        try {
            Save-FileResumable $rel.ZipUrl $zipPath '下载安装包'
        } catch {
            $msg = $_.Exception.Message
            if ($script:LastHttpCode -eq 404) {
                throw ('下载失败：Release 里没有 ' + $rel.ZipName + '（HTTP 404）。可能这个版本还在构建中，请稍后再试。')
            }
            throw ('下载失败：' + $msg + "`n    可能是代理不转发明文 HTTP 或网络不通，请用 -Proxy 指定公司代理，例如：`n    Update-Codex.cmd -Proxy http://10.0.0.1:8080`n    已下载的部分会保留，重新运行即可断点续传。")
        }
        Write-Ok ('下载完成：' + $zipPath)
    }

    # ---- 5. 校验 ----
    if ($expected) {
        Write-Step '校验 SHA-256（约需十几秒）'
        $actual = (Get-Sha256Hex $zipPath)
        if ($actual -ne $expected) {
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
            throw ('SHA-256 校验失败，文件已删除，请重新运行以重新下载。' + "`n    期望：" + $expected + "`n    实际：" + $actual)
        }
        Write-Ok 'SHA-256 校验通过。'
    } else {
        Write-Warn '未校验 SHA-256。'
    }

    # ---- 6. 解压并安装 ----
    Write-Step '解压安装包（约需 1~2 分钟）'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $extractDir = Join-Path $WorkDir ('x' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        try {
            [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractDir)
        } catch {
            throw ('解压失败：' + $_.Exception.Message + '。zip 可能已损坏，已保留在 ' + $zipPath + '，删除它后重新运行即可重新下载。')
        }
        Write-Ok ('已解压到：' + $extractDir)

        $installPs1 = Join-Path $extractDir 'install.ps1'
        if (-not (Test-Path -LiteralPath $installPs1)) {
            $sub = @(Get-ChildItem -LiteralPath $extractDir -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'install.ps1') })
            if ($sub.Count -gt 0) { $installPs1 = Join-Path $sub[0].FullName 'install.ps1' }
        }
        if (-not (Test-Path -LiteralPath $installPs1)) {
            throw '安装包里没有 install.ps1，无法自动安装。请手动解压 zip 并运行其中的 Install-Codex.cmd（或用商店版）。'
        }

        Write-Step '运行安装脚本'
        $psExe = Join-Path $PSHOME 'powershell.exe'
        $installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installPs1, '-InstallRoot', $InstallRoot, '-ReleaseTag', $rel.Tag, '-Yes', '-NoLaunch')
        if ($script:BoundParams.ContainsKey('StartMenuDir')) { $installArgs += @('-StartMenuDir', $StartMenuDir) }
        if ($script:BoundParams.ContainsKey('DesktopDir')) { $installArgs += @('-DesktopDir', $DesktopDir) }
        if ($script:BoundParams.ContainsKey('TaskbarDir')) { $installArgs += @('-TaskbarDir', $TaskbarDir) }
        if ($script:BoundParams.ContainsKey('RegistryRoot')) { $installArgs += @('-RegistryRoot', $RegistryRoot) }
        if ($NoDesktopShortcut) { $installArgs += '-NoDesktopShortcut' }
        if ($SkipRegistry) { $installArgs += '-SkipRegistry' }
        if ($CleanOld) { $installArgs += '-CleanOld' }
        & $psExe @installArgs
        if ($LASTEXITCODE -ne 0) {
            throw ('安装脚本失败（退出码 ' + $LASTEXITCODE + '），详见上面的输出。原有版本已保留/回滚；下载的 zip 保留在 ' + $zipPath + '。')
        }
        $script:NewVersionDir = Join-Path $InstallRoot ('Codex-win-x64-' + $rel.AppVersion)
    } finally {
        if (Test-Path -LiteralPath $extractDir) {
            if (-not (Remove-DirRobust $extractDir)) { Write-Warn ('临时目录未能完全删除，可手动删除：' + $extractDir) }
        }
    }

    # ---- 7. 清理 ----
    if ($KeepDownload) {
        Write-Info ('已保留下载的安装包：' + $zipPath)
    } else {
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        try {
            if (@(Get-ChildItem -LiteralPath $WorkDir -Force -ErrorAction SilentlyContinue).Count -eq 0) { Remove-Item -LiteralPath $WorkDir -Force -ErrorAction SilentlyContinue }
        } catch { }
    }

    Write-Host ''
    Write-Host ('更新完成：' + $relLabel) -ForegroundColor Green
    Write-Info ('安装位置：' + $script:NewVersionDir)

    if (-not $NoLaunch) {
        if (Confirm-Action '现在启动 Codex？' $true) {
            $exe = Join-Path $script:NewVersionDir 'ChatGPT.exe'
            try { Start-Process -FilePath $exe -WorkingDirectory $script:NewVersionDir; Write-Ok '已启动。' }
            catch { Write-Warn ('启动失败：' + $_.Exception.Message) }
        }
    }
}

# 被 dot-source（. .\update.ps1）时只加载函数，不执行主流程，便于测试
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Start-CodexUpdate
        exit 0
    } catch {
        Write-Host ''
        Write-Host ('[错误] ' + $_.Exception.Message) -ForegroundColor Red
        exit 1
    }
}
