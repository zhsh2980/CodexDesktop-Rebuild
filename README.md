# Codex Desktop Rebuild

OpenAI Codex 桌面应用（Electron）的社区重打包版本。Windows 版每天在 GitHub Actions 上自动重新打包，
以 **免安装 zip** 的形式发布在 [Releases](https://github.com/zhsh2980/CodexDesktop-Rebuild/releases)：
**下载、解压、双击安装，不需要管理员权限，不需要微软商店。**

> 本文前半部分面向使用者（安装 / 更新 / 卸载 / 常见问题），构建与开发说明在文末的「开发者」一节。

## 这是什么

- 内容来自 OpenAI 官方发布的 Codex 桌面应用 MSIX 商店包，重新打包成普通目录（`ChatGPT.exe`、`Codex.exe`、`resources/` 等），并打了若干补丁（详见每个发布里的 `BUILD-INFO.json` 和构建日志）。
- 目标是「**下载即用，体验和商店安装的一样**」，同时适合没有商店、没有管理员权限的公司电脑。
- 压缩包里官方的 exe/dll 保留原有的 OpenAI 数字签名；应用本体没有被重新编译。
- 和商店版的关系：这是同一个应用，只是分发方式不同。两者可以并存，但用户数据目录相同（见下文），不建议同时运行。

## 安装（三步，不需要管理员）

1. 到 [Releases](https://github.com/zhsh2980/CodexDesktop-Rebuild/releases) 下载最新的 `Codex-win-x64-<版本>.zip`。
2. 解压到任意位置（解压后的位置只是临时的，安装后可以删掉——除非你想让这次解压的目录本身就是安装目录，见下文「解压即安装」）。
3. 双击 **`Install-Codex.cmd`**。

安装脚本会：

- 在**安装根目录**（默认 `%LOCALAPPDATA%\Programs\CodexApp`）下为这个版本单独建一个文件夹 `Codex-win-x64-<应用版本>`（例如 `Codex-win-x64-26.917.51856`），把程序复制进去——**每个版本各占一个文件夹，互不覆盖**，升级不会动旧版本文件夹；
- 创建/切换开始菜单和桌面的 `Codex` 快捷方式指向这个版本，并创建/切换开始菜单里的「更新 Codex」；如果你之前已经把 `ChatGPT.exe` 或 `Codex.lnk` 固定到了任务栏，也会**原地**把那个固定项改指向新版本（不会新增固定项）；
- 在「设置 → 应用 → 已安装的应用」里登记一个 `Codex` 卸载项（只写当前用户的注册表，不写 HKLM、不装服务）；
- 安装完成后自动做一次自检（关键文件、异常路径、`codex.exe --version`），**通过后才会切换快捷方式**；不通过就自动回滚（只删除本次新建的文件夹，其它版本和快捷方式都不受影响），然后启动应用。

也可以**解压即安装**：把 zip 直接解压到 `<安装根目录>\Codex-win-x64-<版本>` 这个确切路径（也就是安装脚本本来会用的目录），再运行 `Install-Codex.cmd`，脚本发现源目录就是目标目录，会跳过复制，自检通过后直接原地登记为已安装并切换快捷方式。此外，解压后直接双击 `ChatGPT.exe` 也能运行，但不会创建/更新快捷方式和卸载项。

如果目标版本的文件夹**已经存在**、但既不是这次的源目录、也没有本工具留下的安装标记（比如你自己手动建了个同名文件夹），安装脚本会直接**拒绝并且不做任何改动**，提示你重命名该文件夹或换一个 `-InstallRoot`。

`Install-Codex.cmd` 的可选参数（直接写在后面即可）：

| 参数 | 说明 |
|------|------|
| `-InstallRoot <目录>` | 安装根目录（默认 `%LOCALAPPDATA%\Programs\CodexApp`），每个版本是它下面的一个子文件夹 |
| `-NoDesktopShortcut` | 不创建桌面快捷方式 |
| `-NoLaunch` | 安装完成后不启动 |
| `-Force` / `-Yes` | 不询问，直接关闭正在运行的 Codex / 所有询问都视为「是」 |
| `-Reinstall` | 即使这个版本已经装好且自检通过，也强制清空重装 |
| `-CleanOld` | 安装成功后删除**本工具安装、有标记、版本比这次低、当前没有进程在跑、也没有快捷方式指向它**的旧版本文件夹（默认关闭；没有标记的文件夹永远不会被删） |
| `-CleanStale` | 清理旧版本遗留的**无效**注册表项和快捷方式（见下文「清理旧版本残留」） |
| `-SkipRegistry` | 不写「已安装的应用」卸载项 |

## 更新

- **推荐**：双击 **`Update-Codex.cmd`**（在已安装版本的文件夹里，开始菜单里也有「更新 Codex」）。它会检查 GitHub 上的最新发布，比较后下载（支持断点续传和重试）、校验 SHA-256、解压后调用 `install.ps1` 装成一个新的版本文件夹（旧版本文件夹保留，快捷方式切到新版本），完成后询问是否启动。
  - 只想看有没有新版本：`Update-Codex.cmd -CheckOnly`
  - 需要走代理：`Update-Codex.cmd -Proxy http://代理地址:端口`（默认会自动使用环境变量 `HTTPS_PROXY` / `HTTP_PROXY`，再退回系统代理，再直连；`-Proxy direct` 表示强制直连）
  - 顺便清理旧版本文件夹：`Update-Codex.cmd -CleanOld`（规则同上文 `-CleanOld`）
- **手动**：自己下载新的 zip，解压后再双击 `Install-Codex.cmd`，效果一样，会装成一个新的版本文件夹。

**为什么升级不会丢数据？** 安装根目录里只有各版本的程序文件；你的数据不在那里：

| 内容 | 位置 |
|------|------|
| 应用数据（会话、缓存、登录状态等） | `%APPDATA%\Codex` |
| Codex 配置与会话记录 | `%USERPROFILE%\.codex`（例如 `config.toml`） |

升级只会在安装根目录下新建一个版本文件夹（`Codex-win-x64-<新版本>`），复制成功、自检通过后才切换快捷方式指向它；旧版本文件夹默认原样保留（除非加了 `-CleanOld` 且满足清理条件），全程不会读取或修改上面两个位置；卸载默认也会保留它们。

**版本号怎么看？** 发布的 tag（如 `v26.915.4065.0`）用的是**商店包版本**；zip 文件名和版本文件夹名（如 `Codex-win-x64-26.915.31945`）用的是**应用内部版本**（app.asar 里的版本）。两者是不同的数字，这是正常的。更新脚本以发布 tag 为准判断有没有新版本，并会把「应用版本 / 商店包版本 / tag」都显示出来；每个版本文件夹里的安装记录保存在该文件夹下的 `.codexupdater-installed.json`（复制过程中会先出现同目录下的 `.codexupdater-installing` 标记，复制成功并自检通过后才会替换成这个文件）。

**还在用更早的固定目录版本（`%LOCALAPPDATA%\Programs\Codex`，不带版本号）？** 新版本的安装脚本不会自动迁移或删除它，只会在安装完成后提示它还在；确认新版本运行正常后，可以手动删除该目录，或运行该目录里的 `uninstall.ps1`。

## 卸载

- 「设置 → 应用 → 已安装的应用」找到 **Codex**，点卸载；或者运行任意一个已安装版本文件夹里的 `uninstall.ps1`（会作用于整个安装根目录，不止这一个版本）：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\CodexApp\Codex-win-x64-<版本>\uninstall.ps1"
  ```

- 会关闭安装根目录下所有版本正在运行的实例，删除指向安装根目录的开始菜单/桌面/任务栏快捷方式和卸载项，以及安装根目录下**所有带安装标记**的版本文件夹（没有标记的文件夹——比如你自己手动放的东西——永远不会被删）。加 `-KeepFiles` 只清理快捷方式和卸载项，保留所有版本文件夹。
- **不会删除用户数据**：`%APPDATA%\Codex`、`%USERPROFILE%\.codex` 这两个目录任何情况下都不会被卸载脚本触碰，需要清空账号/配置请自行手动删除。

## 和商店安装版的区别（如实说明）

免安装版**没有 MSIX 包身份**，也不写系统级位置，因此：

- 新版商店包里那个**需要管理员才能注册的系统服务**（`CodexSandboxService`，给「Windows 命令沙箱」用）以及对应的**防火墙规则不会被安装**。
- **不使用沙箱的用户不受影响**，例如在 `~/.codex/config.toml` 里配置了 `sandbox_mode = "danger-full-access"`。
- **需要 Windows 沙箱功能的用户，请改用商店安装版。**
- 应用的协议关联、右键菜单、通知等功能，在没有包身份时由应用自己写入**当前用户**的注册表，可以正常使用，不需要管理员。
- 没有商店的自动更新，请用上面的 `Update-Codex.cmd`。

## CLI 说明

应用内置的 CLI（`resources\codex.exe`）默认使用**与应用同版本的官方 CLI**，保证与应用兼容，也不会出现「codex cli 版本太旧」的提示。

「**归档会话可彻底删除**」在默认的官方 CLI 下**就可以用**，而且已经**不需要任何补丁**：

- 26.915 及之后的应用本体已经自带「删除已归档会话 / 全部删除」的界面。
- 它通过 app-server 的 `thread/delete`（参数 `{ threadId }`）真正删除会话，官方 CLI 自 0.15x 起已内置该方法；CLI 不支持时，界面会自己提示「不支持」。
- 早期仓库里曾有一个 `patch-archive-delete` 补丁来手工加这个按钮，**现已删除** —— 功能被官方取代，补丁的锚点也早已失效。

构建时会对**即将随包发布的那个 `codex.exe`** 做一次能力检测（用隔离的临时 `CODEX_HOME` 导出 app-server 的 JSON Schema，查有没有 `thread/delete`），结果记录在 `BUILD-INFO.json` 的 `cli.supportsThreadDelete`；构建后自检（`verify-portable.js` 的 D 项）会现场再测一次，若为「否」则给出警告。

第三方 [cometix](https://github.com/Haleclipse) 版 CLI 仍然保留为**可选项**，仅在你想要它额外的 TUI 定制功能时才需要 —— 手动触发工作流并把 `cli` 选成 `cometix` 即可。注意它通常落后于官方版本。

每次构建实际用了哪一个、以及 `thread/delete` 的检测结果，都会写在构建日志和产物根目录的 `BUILD-INFO.json` 里（`cli.used` / `cli.supportsThreadDelete` 字段）。

## 免安装版是怎么在没有「程序包标识」的情况下运行的

从商店安装的 MSIX 应用有 Windows 的「程序包标识」（package identity），而解压出来直接运行的免安装版没有。官方 **26.915 起**在 `app.asar/package.json` 里新增了一个开关：

```json
"codexWindowsAppContainedCore": "1"
```

它为 `"1"` 时，应用启动早期（`bootstrap-import-main` 阶段）会去向系统要包标识，免安装版拿不到，于是直接弹

> ChatGPT failed to start. 该进程没有程序包标识符。

日志里对应 `error Desktop bootstrap failed to start the main app`。26.908 及更早的版本没有这个键，所以当时免安装版能正常跑。

**本仓库的处理**：构建时由 `scripts/patch-portable-mode.js` 把这个值改成 `"0"`（纯 JSON 数据改动，不碰压缩后的代码，也不改任何官方二进制）。

**万一将来官方换了机制**：CI 的构建后自检带 `--smoke`，会在隔离环境里真的启动一次应用并读日志；起不来就让整个构建失败，而不是把坏包发出去。

作为兜底，压缩包里还附了 `Launch-Codex.cmd`：它设置 `CODEX_CLI_PATH` 后再启动（该环境变量非空同样会跳过包标识检查）。**正常情况下不需要用它。**

## 常见问题

**启动时提示「该进程没有程序包标识符」/ "The process has no package identity"？**
正常构建的包不该出现这个提示（构建时已处理，见上一节）。万一遇到，先试压缩包根目录里的 `Launch-Codex.cmd`；如果它能起来，说明该次构建的 `codexWindowsAppContainedCore` 没被正确置 0，请到仓库提 issue 并附上 `BUILD-INFO.json`。

**双击 `Install-Codex.cmd` 出现 SmartScreen（蓝色「Windows 已保护你的电脑」）提示？**
zip 里官方的 exe 保留 OpenAI 数字签名；`.ps1` 脚本是**未签名**的，因此由 `.cmd` 以 `-ExecutionPolicy Bypass` 方式调用（不需要改系统执行策略）。如果下载的 zip 带有「来自 Internet」标记，可以在解压前右键 zip →「属性」→ 勾选「解除锁定」，或在弹出的提示里点「更多信息 → 仍要运行」。

**更新时下载失败 / 提示 502？**
公司网络通常要通过代理访问 GitHub。有的本地代理软件不转发明文 HTTP，会返回 502；请用 `-Proxy` 指定公司代理，例如 `Update-Codex.cmd -Proxy http://10.0.0.1:8080`。脚本默认会依次尝试：配置的代理（`-Proxy` 或环境变量 `HTTPS_PROXY`/`HTTP_PROXY`）→ 直连 → 系统代理，日志里会写明当前走的是哪一条。看到「证书无效」之类的提示，通常是这条线路上的 HTTPS 被网络设备拦截，换代理即可。已下载的部分会保留，重新运行会断点续传。

**怎么确认安装没问题？**
`Install-Codex.cmd` 复制完成后会自动自检：`ChatGPT.exe`、`resources\app.asar`、`resources\codex.exe` 是否存在，目录里有没有含 `%40oai` 这类 `%XX` 的异常路径（旧包的致命问题），并运行 `resources\codex.exe --version` 显示 CLI 版本。自检不通过时会删除本次新建的版本文件夹、不切换快捷方式，已安装的其它版本保持原样。

**开始菜单/桌面里还有指向旧目录的失效快捷方式，注册表里有一堆残留？**
每个版本装在独立的版本文件夹（`Codex-win-x64-<版本>`）时，应用会在 `HKCU\Software\Classes\CLSID\{...}\LocalServer32` 里按 exe 路径登记通知激活器；如果你用 `-CleanOld` 删除了旧版本文件夹，这些注册表项就会变成指向已删除路径的无效项。要清理这类残留，运行：

```
Install-Codex.cmd -CleanStale
```

它**只清理确认无效**的项：`LocalServer32` 指向不存在的 `ChatGPT.exe`/`Codex.exe`（且所在目录名以 `Codex` 开头）的 CLSID 键，以及指向不存在文件的 Codex 快捷方式。列出数量并经你确认后才会删除，删除前会先把要删的注册表键导出到桌面的 `Codex-清理备份-<时间>.reg`（双击即可还原）。

**和 `~/.codex/config.toml` 的关系？**
应用启动时会自动把 `config.toml` 里 computer use 等相关路径改成**当前安装位置**。如果每次解压到不同的临时目录直接运行，这些路径就会反复变化；用安装脚本装到版本文件夹后，只要这个版本还在，路径就是稳定的（只有升级到新版本文件夹时才会变一次），这也是推荐安装而不是直接运行的原因之一。

**脚本报中文乱码？**
`.cmd` 文件是纯 ASCII，`.ps1` 是 UTF-8 带 BOM，面向 Windows 自带的 Windows PowerShell 5.1。如果你自己编辑了脚本，请保持这两个约定，否则 5.1 会把中文读坏。

---

## 开发者

以下是原有的构建 / 开发说明。

### Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | x64, arm64   | 支持   |
| Windows  | x64          | 支持   |
| Linux    | x64, arm64   | 支持   |

### Build

```bash
# Install dependencies
npm install

# Build for current platform
npm run build

# Build for specific platform
npm run build:mac-x64
npm run build:mac-arm64
npm run build:win-x64
npm run build:linux-x64
npm run build:linux-arm64

# Build all platforms
npm run build:all
```

### Development

```bash
npm run dev
```

### Project Structure

```
├── src/
│   ├── .vite/build/     # Main process (Electron)
│   └── webview/         # Renderer (Frontend)
├── resources/
│   ├── electron.icns    # App icon
│   └── notification.wav # Sound
├── scripts/
│   └── patch-copyright.js
├── installer/           # Windows 安装 / 更新 / 卸载脚本（发布时原样复制进 zip 根目录）
│   ├── Install-Codex.cmd    # 纯 ASCII，调用 install.ps1
│   ├── install.ps1          # 安装 / 升级（原子替换 + 回滚）
│   ├── Update-Codex.cmd     # 纯 ASCII，调用 update.ps1
│   ├── update.ps1           # 检查更新、断点续传下载、校验、调用 install.ps1
│   └── uninstall.ps1        # 卸载（默认保留用户数据）
├── forge.config.js      # Electron Forge config
└── package.json
```

### 安装脚本的约定（修改 `installer/` 时请注意）

- `.cmd` 必须是**纯 ASCII**（不能含中文），否则 cmd.exe 会按 GBK 解析导致乱码；它们只负责调用同目录的 `.ps1`，并且会先 `cd /d %TEMP%` 离开当前目录，避免占用。
- 含中文的 `.ps1` 必须保存为 **UTF-8 带 BOM**，语法必须兼容 Windows PowerShell 5.1（没有 `?:`、`&&`、`Join-Path` 多个子路径等）。
- 按版本分目录安装：`install.ps1` 把每个版本装到 `<InstallRoot>\Codex-win-x64-<appVersion>`（默认 `InstallRoot` 是 `%LOCALAPPDATA%\Programs\CodexApp`），不会重命名或删除其它版本文件夹（唯一例外是显式传 `-CleanOld` 时，按规则清理有标记、版本更低、无进程、无快捷方式引用的旧版本）。
- 标记文件约定（与本机独立的商店包更新工具共用同一套字段，便于互认对方装的版本）：复制期间在版本目录下放 `.codexupdater-installing`；成功后删除它并写 `.codexupdater-installed.json`（UTF-8 无 BOM），字段包括 `appVersion`、`msixVersion`、`installedAt`、`toolVersion`、`source`、`flavor`、`releaseTag`、`zipName`。安装/升级失败时只删除本次新建的、带 `installing` 标记的文件夹。
- 脚本依赖 `BUILD-INFO.json` 里的字段（都可缺失，缺失时容错为空）：`version`（=应用版本，兼容旧字段）、`appVersion`（app.asar 版本，用于决定版本文件夹名，缺失时依次回退 `version`、`msixVersion`）、`msixVersion`（商店包版本）、`zipName`、`cli.used`。
- `update.ps1` 把安装根目录下带标记、`appVersion` 最高的文件夹当作"当前版本"，优先用它的 `releaseTag`（其次 `msixVersion`）与最新发布 tag 比较。
- `update.ps1` 通过 `releases/latest` 的 302 得到 tag，再读 `releases/expanded_assets/<tag>` 得到真实的 zip 文件名（tag 是商店包版本，zip 名是应用版本，不能互相拼），两条都失败才回退到 GitHub API。
- 所有脚本参数都可以指向临时目录/临时注册表键（`-InstallRoot`、`-StartMenuDir`、`-DesktopDir`、`-TaskbarDir`、`-RegistryRoot`、`-ClassesRoot`、`-BaseUrl`、`-ApiUrl` 等），便于在不污染真实环境的前提下测试；`update.ps1` 的旧参数 `-InstallDir` 仍保留作兼容别名。

### CI/CD

GitHub Actions automatically builds on:
- Push to `master`
- Tag `v*` → Creates draft release

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild & [@cometix/codex](https://www.npmjs.com/package/@cometix/codex) binaries
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.
