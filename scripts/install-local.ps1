# Install qwen-code with the llama.cpp fork as its local engine, on Windows,
# from the two checkouts side by side:
#
#   git clone https://github.com/Cemberk/qwen-code      (branch adaptive-local-inference)
#   git clone https://github.com/Cemberk/llama.cpp      (branch adaptive-moe)
#   cd qwen-code
#   powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
#
# It builds qwen-code, builds the fork's llama-server for this machine's GPU
# (the backend /models setup recommends), adds a `qwen` command to
# %USERPROFILE%\.local\bin (and that folder to your user PATH), and sets
# localModelEngine in %USERPROFILE%\.qwen\settings.json. Without the Vulkan
# SDK (its installer needs administrator rights), it gathers what the Vulkan
# build needs with the fork's scripts\windows-vulkan-noadmin.ps1.
#
# Needs Node.js 22 or later, git, CMake and the Visual Studio Build Tools (C++):
#   winget install OpenJS.NodeJS.LTS Git.Git Kitware.CMake
#   winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
# and for NVIDIA the CUDA Toolkit (winget install Nvidia.CUDA).
# Behind a TLS-inspecting proxy, set $env:NODE_OPTIONS = '--use-system-ca' first.

param(
    [string]$LlamaDir = '',
    [int]$Jobs = 4,               # lower it on 16 GB or less
    [switch]$DownloadModel        # also download the default model (13.7 GB) with hf
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step($text) { Write-Host "`n== $text" }
function Fail($text) { Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }
function Run($exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { Fail "$exe $($arguments -join ' ') failed ($LASTEXITCODE)." }
}

$QwenDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $LlamaDir) { $LlamaDir = Join-Path (Split-Path $QwenDir -Parent) 'llama.cpp' }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'Node.js 22 or later is needed: winget install OpenJS.NodeJS.LTS' }
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node.js $(& $node --version) is too old: Node.js 22 or later is needed." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is needed: winget install Git.Git' }
$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) { $cmake = 'C:\Program Files\CMake\bin\cmake.exe' }
if (-not (Test-Path $cmake)) { Fail 'CMake is needed: winget install Kitware.CMake' }
if (-not (Test-Path (Join-Path $LlamaDir '.git'))) {
    Fail "No llama.cpp checkout at ${LlamaDir}: clone https://github.com/Cemberk/llama.cpp there, or pass -LlamaDir."
}

Step "Building qwen-code in $QwenDir"
Push-Location $QwenDir
Run 'corepack' @('pnpm', 'install', '--frozen-lockfile')
Run 'npm' @('run', 'build')
Run 'npm' @('run', 'bundle')
$backend = (& $node scripts\local-setup.mjs backend).Trim()
[string[]]$cmakeArgs = & $node scripts\local-setup.mjs cmake-args
Pop-Location

if ($backend -eq 'vulkan' -and -not $env:VULKAN_SDK) {
    Step 'No Vulkan SDK: gathering the Vulkan build tools without administrator rights'
    $root = Join-Path $env:USERPROFILE 'vulkan-local'
    & (Join-Path $LlamaDir 'scripts\windows-vulkan-noadmin.ps1') -Root $root
    if ($LASTEXITCODE -ne 0) { Fail 'scripts\windows-vulkan-noadmin.ps1 failed.' }
    $install = (Join-Path $root 'install') -replace '\\', '/'
    $cmakeArgs += @(
        "-DVulkan_INCLUDE_DIR=$install/include",
        "-DVulkan_LIBRARY=$install/lib/vulkan-1.lib",
        "-DVulkan_GLSLC_EXECUTABLE=$(((Join-Path $root 'shaderc\install\bin\glslc.exe') -replace '\\', '/'))",
        "-DSPIRV-Headers_DIR=$install/share/cmake/SPIRV-Headers"
    )
}

Step "Building llama-server in $LlamaDir (backend: $backend, $Jobs jobs)"
Push-Location $LlamaDir
& git show-ref --verify --quiet refs/heads/adaptive-moe
$hasBranch = $LASTEXITCODE -eq 0
if (-not $hasBranch) {
    & git ls-remote --exit-code --heads origin adaptive-moe *> $null
    $hasBranch = $LASTEXITCODE -eq 0
}
if ($hasBranch) { Run 'git' @('checkout', 'adaptive-moe') }
Run $cmake (@('-B', 'build') + $cmakeArgs)
Run $cmake @('--build', 'build', '--config', 'Release', '--target', 'llama-server', '-j', "$Jobs")
Pop-Location
$engine = Join-Path $LlamaDir 'build\bin\Release\llama-server.exe'
if (-not (Test-Path $engine)) { Fail "The build did not produce $engine." }

Step 'Adding the qwen command'
$bin = Join-Path $env:USERPROFILE '.local\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Set-Content -Encoding ascii -Path (Join-Path $bin 'qwen.cmd') -Value "@`"$node`" `"$QwenDir\dist\cli.js`" %*"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin", 'User')
    Write-Host "Added $bin to your user PATH: open a new terminal to use qwen."
}

Step 'Pointing qwen at the engine'
Run $node @((Join-Path $QwenDir 'scripts\local-setup.mjs'), 'set-engine', $engine)

if ($DownloadModel) {
    Step 'Downloading the default model'
    if (-not (Get-Command hf -ErrorAction SilentlyContinue)) {
        Fail 'hf is needed to download models: pip install -U "huggingface_hub[cli]"'
    }
    Run 'hf' @('download', 'unsloth/Qwen3.6-35B-A3B-GGUF', 'Qwen3.6-35B-A3B-UD-IQ3_S.gguf')
}

Step 'Done'
Write-Host @'
Run qwen in a project folder. Inside it:
  /models setup   this machine's GPUs, the engine and how it is kept off the network
  /models         the local models; /models download <id> fetches one
  /models plan    how a model runs here; /models bench measures it
'@
