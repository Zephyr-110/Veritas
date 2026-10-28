$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$ProgramId = 'CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER'
$TokenId = '2Ztk1WhiRrFqZZktipzPEQghJFNJbA8C1LL1v3LsWCiP'
$So = Join-Path (Get-Location) 'target\deploy\prediction_market.so'
$ProgramKeypair = Join-Path (Get-Location) 'target\deploy\prediction_market-keypair.json'

if (-not (Get-Command solana -ErrorAction SilentlyContinue)) {
  throw 'PATH 里没有 solana。如果 CLI 在 WSL 里，请改用 wsl 跑同一套命令。'
}
Write-Host "solana $(solana --version)"
$hasAnchor = [bool](Get-Command anchor -ErrorAction SilentlyContinue)
if ($hasAnchor) { Write-Host "anchor $(anchor --version)" }

solana config set --url https://api.devnet.solana.com | Out-Host
Write-Host "wallet $(solana address)"
solana balance | Out-Host

Write-Host "`n=== prediction_market ==="
solana program show $ProgramId
Write-Host "`n=== meme_token keep ==="
solana program show $TokenId

if (-not (Test-Path -LiteralPath $So)) { throw "missing $So" }
Write-Host "`n=== deploy/upgrade ==="
if ($hasAnchor) {
  anchor deploy --provider.cluster devnet --program-name prediction_market --program-keypair $ProgramKeypair
} else {
  solana program deploy $So --program-id $ProgramKeypair --url https://api.devnet.solana.com
}

Write-Host "`n=== leftover buffers ==="
solana program show --buffers
Write-Host "`n=== after ==="
solana program show $ProgramId
solana balance | Out-Host
Write-Host 'meme_token was not closed. GeLQ6 was closed so this deploys the new program id. Prefer WSL: bash scripts/deploy-devnet.sh'
