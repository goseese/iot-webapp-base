<#
devmon one time IIS install. Run as Administrator in PowerShell on the Windows Server.
  powershell -ExecutionPolicy Bypass -File install.ps1 -Domain devmon.datatelematics.io -AppDir C:\apps\devmon -Email you@example.com

What it does, in order (each step is idempotent):
  1. Checks Node 22 and npm are on PATH.
  2. Installs IIS with the pieces the proxy needs (Web-Server, WebSockets, request filtering) and
     checks ARR + URL Rewrite are present (downloads must be run by hand; links printed).
  3. Creates the app directory and the storage/logs folders.
  4. Installs pm2 and pm2-windows-service globally and registers the PM2 service.
  5. Creates the IIS site bound to the domain on 80 and 443, drops in web.config, enables ARR proxy.
  6. Requests a certificate with win-acme and binds it (win-acme handles renewals as a task).
  7. Opens 80/443 on the firewall.
It does NOT: copy the code (your git push does that), create the database login (deploy/create-app-login.sql),
or write .env (copy .env.example to .env on the box and fill it in).
#>
param(
    [Parameter(Mandatory = $true)][string]$Domain,
    [string]$AppDir = "C:\apps\devmon",
    [string]$SiteName = "devmon",
    [string]$Email = "",
    [int]$Port = 3000
)
$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

Step "Node"
$node = (& node -v) 2>$null
if (-not $node -or -not $node.StartsWith("v22")) { throw "Node 22 is required on PATH (found '$node'). Install from https://nodejs.org/en/download and rerun." }
Write-Host "node $node, npm $(& npm -v)"

Step "IIS features"
$features = @("Web-Server", "Web-WebServer", "Web-Common-Http", "Web-Static-Content", "Web-Default-Doc", "Web-Http-Errors", "Web-Http-Logging", "Web-Request-Monitor", "Web-Filtering", "Web-WebSockets", "Web-Mgmt-Console")
foreach ($f in $features) { if ((Get-WindowsFeature $f).InstallState -ne "Installed") { Install-WindowsFeature $f | Out-Null; Write-Host "installed $f" } }
Import-Module WebAdministration

$rewrite = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\IIS Extensions\URL Rewrite" -ErrorAction SilentlyContinue
$arr = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\IIS Extensions\Application Request Routing" -ErrorAction SilentlyContinue
if (-not $rewrite) { Write-Warning "URL Rewrite 2.1 is not installed: https://www.iis.net/downloads/microsoft/url-rewrite  Install it, then rerun." }
if (-not $arr) { Write-Warning "Application Request Routing 3.0 is not installed: https://www.iis.net/downloads/microsoft/application-request-routing  Install it, then rerun." }
if (-not $rewrite -or -not $arr) { throw "Install the missing IIS extensions above and rerun install.ps1." }

Step "App directory $AppDir"
foreach ($d in @($AppDir, "$AppDir\storage", "$AppDir\storage\reports", "$AppDir\logs")) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }
Copy-Item "$PSScriptRoot\web.config" "$AppDir\web.config" -Force
if (-not (Test-Path "$AppDir\.env")) { Write-Warning "$AppDir\.env does not exist yet. Copy .env.example there and fill it in before deploy.ps1." }

Step "pm2 as a Windows service"
& npm install -g pm2 pm2-windows-service | Out-Null
$env:PM2_HOME = "C:\ProgramData\pm2"
[Environment]::SetEnvironmentVariable("PM2_HOME", $env:PM2_HOME, "Machine")
if (-not (Test-Path $env:PM2_HOME)) { New-Item -ItemType Directory -Path $env:PM2_HOME | Out-Null }
if (-not (Get-Service PM2 -ErrorAction SilentlyContinue))
{
    Write-Host "registering PM2 service (answer the prompts: PM2_HOME=$env:PM2_HOME, service name PM2)"
    & pm2-service-install -n PM2
}
else { Write-Host "PM2 service already registered" }

Step "IIS site $SiteName for $Domain"
$pool = "devmon"
if (-not (Test-Path "IIS:\AppPools\$pool")) { New-WebAppPool -Name $pool | Out-Null; Set-ItemProperty "IIS:\AppPools\$pool" managedRuntimeVersion "" }
if (-not (Get-Website -Name $SiteName -ErrorAction SilentlyContinue))
{
    New-Website -Name $SiteName -PhysicalPath $AppDir -ApplicationPool $pool -HostHeader $Domain -Port 80 | Out-Null
}
# ARR proxy mode on at the server level (needed once per box).
Set-WebConfigurationProperty -PSPath "MACHINE/WEBROOT/APPHOST" -Filter "system.webServer/proxy" -Name "enabled" -Value "True"
Set-WebConfigurationProperty -PSPath "MACHINE/WEBROOT/APPHOST" -Filter "system.webServer/proxy" -Name "preserveHostHeader" -Value "True"
# Allow the rewrite rule to set X-Forwarded-* server variables.
$allowed = Get-WebConfiguration -PSPath "MACHINE/WEBROOT/APPHOST/$SiteName" -Filter "system.webServer/rewrite/allowedServerVariables/add"
foreach ($v in @("HTTP_X_FORWARDED_PROTO", "HTTP_X_FORWARDED_HOST"))
{
    if (-not ($allowed | Where-Object { $_.name -eq $v })) { Add-WebConfiguration -PSPath "MACHINE/WEBROOT/APPHOST/$SiteName" -Filter "system.webServer/rewrite/allowedServerVariables" -Value @{ name = $v } }
}

Step "Certificate (win-acme)"
$wacs = Get-ChildItem "C:\tools\win-acme\wacs.exe", "C:\Program Files\win-acme\wacs.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $wacs)
{
    Write-Warning "win-acme not found. Download https://www.win-acme.com/ to C:\tools\win-acme and run:"
    Write-Host "  C:\tools\win-acme\wacs.exe --target iis --siteid $((Get-Website $SiteName).id) --host $Domain --emailaddress $Email --accepttos"
}
else
{
    & $wacs.FullName --target iis --siteid (Get-Website $SiteName).id --host $Domain --emailaddress $Email --accepttos
}

Step "Firewall"
foreach ($p in 80, 443) { if (-not (Get-NetFirewallRule -DisplayName "devmon $p" -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName "devmon $p" -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow | Out-Null } }

Write-Host "`nInstall done. Next: put the code in $AppDir (git), create $AppDir\.env, run deploy\create-app-login.sql, then deploy.ps1." -ForegroundColor Green
