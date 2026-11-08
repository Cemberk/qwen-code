# Update qwen-code and the llama.cpp fork on Windows, from the two checkouts
# side by side, and rebuild both:
#
#   cd qwen-code
#   powershell -ExecutionPolicy Bypass -File scripts\update-local.ps1
#
# It refuses to run when either checkout has local changes, fast-forwards
# qwen-code to adaptive-local-inference and llama.cpp to adaptive-moe,
# stops the local model pool (a running engine locks its .exe, so it could
# not be rebuilt), then runs scripts\install-local.ps1 with the same options
# (-LlamaDir, -Jobs, -DownloadModel).

param(
    [string]$LlamaDir = '',
    [int]$Jobs = 4,
    [switch]$DownloadModel,
    # Stop the local model pool even while qwen sessions use it.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n== $text" }
function Fail($text) { Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

# Run a native command, its output and errors discarded, and give its exit
# code. Windows PowerShell 5.1 turns a native command's redirected stderr
# into error records, which $ErrorActionPreference = 'Stop' makes fatal.
function Quiet([string]$exe, [string[]]$arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $exe @arguments *> $null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

# Run a native command and give its standard output, errors discarded.
function Output([string]$exe, [string[]]$arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        return ((& $exe @arguments 2>$null) | Out-String)
    } finally {
        $ErrorActionPreference = $previous
    }
}

$QwenDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $LlamaDir) { $LlamaDir = Join-Path (Split-Path $QwenDir -Parent) 'llama.cpp' }

function Update($dir, $branch) {
    if (-not (Test-Path (Join-Path $dir '.git'))) { Fail "No checkout at $dir." }
    $changes = & git -C $dir status --porcelain --untracked-files=no
    if ($changes) { Fail "$dir has local changes: commit or stash them first." }
    Step "Updating $dir ($branch)"
    & git -C $dir fetch origin $branch
    if ($LASTEXITCODE -ne 0) { Fail "git fetch failed in $dir." }
    & git -C $dir checkout $branch
    if ($LASTEXITCODE -ne 0) { Fail "git checkout $branch failed in $dir." }
    & git -C $dir merge --ff-only "origin/$branch"
    if ($LASTEXITCODE -ne 0) {
        Fail "$dir has commits that are not on origin/${branch}: rebase or push them first."
    }
}

Update $QwenDir 'adaptive-local-inference'
Update $LlamaDir 'adaptive-moe'

$cli = Join-Path $QwenDir 'dist\cli.js'
if (Test-Path $cli) {
    $status = Output 'node' @($cli, 'pool', 'status')
    if (-not $Force -and $status -match 'qwen sessions attached: ([1-9]\d*)') {
        Fail "$($Matches[1]) qwen session(s) use the local model pool: close them first (or add -Force; their next request then starts it again)."
    }
    if ($status -match 'pool runs') {
        Step 'Stopping the local model pool'
        Quiet 'node' @($cli, 'pool', 'stop') | Out-Null
        Start-Sleep -Seconds 2
    }
}

$install = Join-Path $QwenDir 'scripts\install-local.ps1'
$arguments = @{ LlamaDir = $LlamaDir; Jobs = $Jobs }
if ($DownloadModel) { $arguments['DownloadModel'] = $true }
& $install @arguments
exit $LASTEXITCODE
