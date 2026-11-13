[CmdletBinding()]
param([switch]$CheckOnly, [switch]$InstallUpscale, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$runtime = Join-Path $root '.workspace-data'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$privatePython = Join-Path $runtime 'runtime\python\python.exe'
$pythonUri = 'https://www.python.org/ftp/python/3.13.17/python-3.13.17-amd64.exe'
$engineUri = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip'
$engineDirectory = Join-Path $runtime 'vendor\realesrgan'
if ($env:FENGSHA_UPSCALE_ENGINE_DIR) { $engineDirectory = $env:FENGSHA_UPSCALE_ENGINE_DIR }
$requirements = Join-Path $root 'requirements.txt'

function Confirm-Install([string]$Message) {
    Write-Host $Message -ForegroundColor Yellow
    return (Read-Host 'Type Y to install, or press Enter to skip') -eq 'Y'
}

function Find-Python {
    $candidates = @($privatePython)
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        foreach ($version in @('-3.13', '-3.12')) {
            try {
                $path = & $launcher.Source $version -c 'import sys; print(sys.executable)' 2>$null
                if ($LASTEXITCODE -eq 0) { $candidates += $path }
            } catch { continue }
        }
    }
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand -and $pythonCommand.Source -notmatch '\\WindowsApps\\') { $candidates += $pythonCommand.Source }
    foreach ($path in $candidates) {
        if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
            try {
                & $path -c "import sys,sysconfig; raise SystemExit(not ((3,12) <= sys.version_info[:2] <= (3,13) and sysconfig.get_platform()=='win-amd64'))" 2>$null
                if ($LASTEXITCODE -eq 0) { return $path }
            } catch { continue }
        }
    }
}

function Receive-Archive([string]$Uri, [string]$Destination, [string]$Sha256) {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination -TimeoutSec 120
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Sha256) {
        throw 'Downloaded file did not match its SHA-256 checksum.'
    }
}

function Test-UpscaleInstall([string]$Directory) {
    return ((Test-Path -LiteralPath (Join-Path $Directory 'realesrgan-ncnn-vulkan.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Directory 'models\realesrgan-x4plus.bin') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Directory 'models\realesrgan-x4plus.param') -PathType Leaf))
}

function Install-LocalUpscale {
    if (Test-UpscaleInstall $engineDirectory) { Write-Host 'Local Real-ESRGAN is already installed.'; return }
    if ($env:FENGSHA_UPSCALE_ENGINE_DIR) { throw 'The configured FENGSHA_UPSCALE_ENGINE_DIR does not contain a complete engine.' }
    if (-not (Test-Path -LiteralPath (Join-Path $env:windir 'System32\vulkan-1.dll') -PathType Leaf)) {
        throw 'Windows has no Vulkan runtime. Update the GPU driver from its vendor if you want to use local upscale.'
    }
    if (Test-Path -LiteralPath $engineDirectory) {
        throw 'An incomplete Real-ESRGAN folder already exists. Use another engine directory or repair that folder before installing.'
    }
    if (-not (Confirm-Install 'Optional: download the official Real-ESRGAN Windows ZIP and test it on your GPU. The app works without it.')) { return }
    $vendor = Split-Path -Parent $engineDirectory
    $staging = Join-Path $vendor ('realesrgan-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    $zip = Join-Path $staging 'engine.zip'
    $engine = Join-Path $staging 'engine'
    Receive-Archive $engineUri $zip 'ABC02804E17982A3BE33675E4D471E91EA374E65B70167ABC09E31ACB412802D'
    Expand-Archive -LiteralPath $zip -DestinationPath $engine
    if (-not (Test-UpscaleInstall $engine)) { throw 'The downloaded engine is incomplete.' }
    $testOutput = Join-Path $staging 'test.png'
    $testArgs = '-i input.jpg -o "' + $testOutput + '" -m models -n realesr-animevideov3 -s 2 -t 64 -j 1:1:1'
    $test = Start-Process -FilePath (Join-Path $engine 'realesrgan-ncnn-vulkan.exe') -ArgumentList $testArgs -WorkingDirectory $engine -PassThru -WindowStyle Hidden
    if (-not $test.WaitForExit(90000)) {
        $test.Kill()
        throw 'Real-ESRGAN timed out during the GPU test. The optional engine was not enabled.'
    }
    if ($test.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $testOutput -PathType Leaf)) {
        throw 'Real-ESRGAN failed the GPU test. Use the app without local upscale or configure cloud upscale.'
    }
    Move-Item -LiteralPath $engine -Destination $engineDirectory
    Remove-Item -LiteralPath $zip, $testOutput
    Remove-Item -LiteralPath $staging
    Write-Host 'Local Real-ESRGAN installed and GPU test passed.' -ForegroundColor Green
}

$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or [Environment]::OSVersion.Version.Build -lt 10240 -or
    $architecture -ne 'AMD64') {
    throw 'This release supports x64 Windows 10 and 11.'
}
Write-Host ('Windows x64 build ' + [Environment]::OSVersion.Version.Build)
$disk = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($root))
Write-Host ('Free space: {0:N1} GB on {1}' -f ($disk.AvailableFreeSpace / 1GB), $disk.Name)
$python = Find-Python
if ($python) { Write-Host ('Python: ' + (& $python --version)) }
else { Write-Host 'Python x64 3.12 or 3.13: required for the main app.' }
$vulkan = Test-Path -LiteralPath (Join-Path $env:windir 'System32\vulkan-1.dll') -PathType Leaf
Write-Host ('Optional Real-ESRGAN: files present = {0}; Vulkan loader present = {1}' -f (Test-UpscaleInstall $engineDirectory), $vulkan)
if ($CheckOnly -or $InstallUpscale) {
    $adapters = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    if ($adapters) { Write-Host ('Display adapters: ' + ($adapters -join ', ')) }
    Write-Host ('Windows PowerShell for built-in OCR: ' + [bool](Get-Command powershell.exe -ErrorAction SilentlyContinue))
}
if ($CheckOnly) { return }
if ($InstallUpscale) { Install-LocalUpscale; return }

$port = 8766
if ($env:FENGSHA_WORKSPACE_PORT -and (-not [int]::TryParse($env:FENGSHA_WORKSPACE_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535)) {
    throw 'FENGSHA_WORKSPACE_PORT must be a port from 1 to 65535.'
}
$localUri = "http://127.0.0.1:$port/"
$running = try { Invoke-RestMethod -Uri ($localUri + 'api/health') -TimeoutSec 1 } catch { $null }
if ($running -and $running.service -eq 'fengsha-workspace') {
    Write-Host 'The workbench is already running. To load updated code, stop its original window before restarting.'
    if (-not $NoBrowser) { Start-Process $localUri }
    return
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
try { $listener.Start() } catch { throw "Port $port is in use. Close the program using it or choose another FENGSHA_WORKSPACE_PORT." }
finally { $listener.Stop() }

$marker = Join-Path $root '.venv\requirements.sha256'
$requirementsHash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash
$installed = (Test-Path -LiteralPath $venvPython) -and (Test-Path -LiteralPath $marker) -and
    (Get-Content -LiteralPath $marker -Raw).Trim() -eq $requirementsHash
if (-not $installed -and $disk.AvailableFreeSpace -lt 512MB) { throw 'Free at least 512 MB in the project drive for the first installation.' }
if (-not $installed) {
    if (-not $python) {
        if (-not (Confirm-Install 'Required: install official Python 3.13 x64 inside this folder, for this app.')) { return }
        $installer = Join-Path $runtime 'python-3.13-amd64.exe'
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        Receive-Archive $pythonUri $installer '5DA012101BA2E17113A9A1CD901E9CE1441086F2B7ECB5DE06EC94163899A190'
        $signature = Get-AuthenticodeSignature -LiteralPath $installer
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Python Software Foundation') {
            throw 'Could not verify the Python Software Foundation installer signature.'
        }
        $target = Split-Path -Parent $privatePython
        $installerArgs = '/quiet InstallAllUsers=0 Include_launcher=0 PrependPath=0 AssociateFiles=0 Shortcuts=0 Include_test=0 Include_doc=0 Include_tcltk=0 TargetDir="' + $target + '"'
        $process = Start-Process -FilePath $installer -ArgumentList $installerArgs -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $privatePython -PathType Leaf)) {
            throw "Python installer returned $($process.ExitCode). Install Python manually from python.org and run this launcher again."
        }
        Remove-Item -LiteralPath $installer
        $python = $privatePython
    }
    if (-not (Confirm-Install 'Required: prepare the project environment and install Python packages from requirements.txt.')) { return }
    if (-not (Test-Path -LiteralPath $venvPython)) {
        & $python -m venv (Join-Path $root '.venv')
        if ($LASTEXITCODE) { throw 'Could not create the project Python environment.' }
    }
    & $venvPython -m pip install --disable-pip-version-check --only-binary=:all: -r $requirements
    if ($LASTEXITCODE) { throw 'Dependency installation failed. Check your internet connection and run this launcher again.' }
    & $venvPython -m pip check
    if ($LASTEXITCODE) { throw 'Python dependencies are inconsistent.' }
    Set-Content -LiteralPath $marker -Value $requirementsHash -Encoding ascii
}

Write-Host ("Open $localUri in your browser. Press Ctrl+C here to stop the workbench.")
if ($NoBrowser) { & $venvPython -u workspace_server.py }
else { & $venvPython -u workspace_server.py --open-browser }
exit $LASTEXITCODE
