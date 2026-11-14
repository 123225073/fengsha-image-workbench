[CmdletBinding()]
param([string]$Version, [switch]$PlanOnly)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$serverSource = Get-Content -LiteralPath (Join-Path $packageRoot 'workspace_server.py') -Raw -Encoding UTF8
$serverVersion = [regex]::Match($serverSource, 'FengshaWorkspace/([0-9]+\.[0-9]+\.[0-9]+)').Groups[1].Value
if (-not $Version) { $Version = $serverVersion }
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$' -or $Version -ne $serverVersion) {
    throw 'Package version must match the running source version in workspace_server.py.'
}
$packageDirectory = Join-Path $packageRoot '.workspace-data\deliveries'
$packageStem = 'fengsha-image-workbench-' + $Version
$packagePath = Join-Path $packageDirectory ($packageStem + '-windows.zip')
$packageChecksum = $packagePath + '.sha256'
$packageManifest = Join-Path $packageDirectory ($packageStem + '-manifest.json')
$files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()

function Add-PackageFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw ('Only regular files can be packaged: ' + $Path)
    }
    if (-not $item.FullName.StartsWith($packageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('Package source is outside this project: ' + $Path)
    }
    $ancestor = $item.Directory
    while ($ancestor -and $ancestor.FullName.Length -ge $packageRoot.Length) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Linked source directories are not packaged: ' + $ancestor.FullName) }
        if ($ancestor.FullName -eq $packageRoot) { break }
        $ancestor = $ancestor.Parent
    }
    $files.Add($item)
}

function Add-PackageTree([string]$Directory, [string[]]$Extensions) {
    $folder = Get-Item -LiteralPath $Directory -Force
    if ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Linked directories are not packaged: ' + $Directory) }
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Linked content is not packaged: ' + $item.FullName) }
        if ($item.PSIsContainer) {
            if (-not $item.Name.StartsWith('.') -and $item.Name -ne '__pycache__') { Add-PackageTree $item.FullName $Extensions }
        } elseif ($item.Extension -in $Extensions -and -not $item.Name.StartsWith('.')) { Add-PackageFile $item.FullName }
    }
}

foreach ($name in @('workspace_server.py', 'requirements.txt', 'README.md', 'LICENSE', '.gitignore',
                    '本地使用与验收.md', '启动本地工作台.cmd', '检查电脑环境.cmd', '安装可选本地超分.cmd',
                    'scripts\start-windows.ps1', 'scripts\package-windows.ps1')) {
    Add-PackageFile (Join-Path $packageRoot $name)
}
foreach ($item in Get-ChildItem -LiteralPath $packageRoot -File -Filter 'commercial_*.py') { Add-PackageFile $item.FullName }
Add-PackageTree (Join-Path $packageRoot 'frontend') @('.html', '.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff2')
Add-PackageTree (Join-Path $packageRoot 'docs') @('.md')
foreach ($item in Get-ChildItem -LiteralPath (Join-Path $packageRoot 'tests') -File) {
    if ($item.Name -like 'test_*.py' -or $item.Name -like 'frontend_*.cjs') { Add-PackageFile $item.FullName }
}
$sources = @($files | Sort-Object FullName -Unique)
$relativeNames = @($sources | ForEach-Object { $_.FullName.Substring($packageRoot.Length + 1).Replace('\', '/') })
if ($relativeNames | Where-Object { $_ -match '(^|/)(\.commercial-data|\.workspace-data|\.venv|\.git|\.env|node_modules)(/|$)|\.(sqlite3?|db|key|pem|pfx|p12)$' }) {
    throw 'Local data, environments, model downloads and credentials must never enter a delivery package.'
}
if ($PlanOnly) {
    [pscustomobject]@{Version=$Version; FileCount=$sources.Count; SourceBytes=($sources | Measure-Object Length -Sum).Sum;
        PackagePath=$packagePath; Files=$relativeNames}
    return
}
foreach ($target in @($packagePath, $packageChecksum, $packageManifest)) {
    if (Test-Path -LiteralPath $target) { throw ('This version already has an output; inspect it before replacing: ' + $target) }
}
New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$pendingArchive = Join-Path $packageDirectory ($packageStem + '-' + [guid]::NewGuid().ToString('N') + '.partial')
$manifest = [ordered]@{}
$archive = $null
try {
    $archive = [IO.Compression.ZipFile]::Open($pendingArchive, [IO.Compression.ZipArchiveMode]::Create)
    for ($index = 0; $index -lt $sources.Count; $index++) {
        $source = $sources[$index]
        $relative = $relativeNames[$index]
        $manifest[$relative] = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal)
    }
    $archive.Dispose(); $archive = $null
    $archive = [IO.Compression.ZipFile]::OpenRead($pendingArchive)
    if ($archive.Entries.Count -ne $sources.Count) { throw 'Archive file count does not match the source inventory.' }
    foreach ($entry in $archive.Entries) {
        $stream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $sha.Dispose() }
        if ($actual -ne $manifest[$entry.FullName]) { throw ('Source changed or archive verification failed: ' + $entry.FullName) }
    }
    $archive.Dispose(); $archive = $null
    Move-Item -LiteralPath $pendingArchive -Destination $packagePath
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($packageManifest, ($manifest | ConvertTo-Json -Depth 4), $utf8)
    $hash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($packageChecksum, ($hash + '  ' + [IO.Path]::GetFileName($packagePath) + [Environment]::NewLine), $utf8)
    [pscustomobject]@{Version=$Version; PackagePath=$packagePath; Files=$sources.Count; Bytes=(Get-Item -LiteralPath $packagePath).Length;
        Sha256=$hash; Manifest=$packageManifest; Checksum=$packageChecksum}
} finally {
    if ($archive) { $archive.Dispose() }
    # This unique partial file is created exclusively by this invocation.
    if (Test-Path -LiteralPath $pendingArchive -PathType Leaf) { Remove-Item -LiteralPath $pendingArchive }
}
