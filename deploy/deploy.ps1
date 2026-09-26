<#
devmon deploy for the ARR + pm2 layout (not used with iisnode; see README.md). Run after the code has been copied to the app directory (by your git push pipeline
or by hand). Safe to run repeatedly.
  powershell -ExecutionPolicy Bypass -File deploy.ps1 -AppDir C:\apps\devmon

  1. npm ci (exact lockfile)
  2. migrations then seeds, as the only process touching the schema (ROLE=web never migrates)
  3. pm2 startOrReload of ecosystem.config.js (web + ingest), saved so the PM2 service restores them on reboot
  4. health check against http://127.0.0.1:3000/health
#>
param([string]$AppDir = "C:\apps\devmon")
$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
$env:PM2_HOME = "C:\ProgramData\pm2"
Set-Location $AppDir
if (-not (Test-Path ".env")) { throw "$AppDir\.env is missing. Copy .env.example and fill it in." }
if (-not (Test-Path "package-lock.json")) { throw "package-lock.json is missing; commit it from the dev machine (npm install writes it)." }

Step "Dependencies"
& npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

Step "Database migrations and seeds"
$env:NODE_ENV = "production"
& node scripts/migrate.js
if ($LASTEXITCODE -ne 0) { throw "migrations failed; nothing was restarted" }
& node scripts/seed.js
if ($LASTEXITCODE -ne 0) { throw "seeds failed; nothing was restarted" }

Step "pm2"
& pm2 startOrReload ecosystem.config.js --update-env
if ($LASTEXITCODE -ne 0) { throw "pm2 reload failed" }
& pm2 save | Out-Null

Step "Health"
Start-Sleep -Seconds 4
try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/health" -UseBasicParsing -TimeoutSec 10; Write-Host $r.Content }
catch { & pm2 logs web --lines 40 --nostream; throw "health check failed; see pm2 logs above" }
Write-Host "`nDeploy done." -ForegroundColor Green
