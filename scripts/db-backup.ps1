# نسخة احتياطية لقاعدة بيانات سيستم ٧ (custom format + عدّ صفوف)
# الاستخدام:  .\scripts\db-backup.ps1 -OutDir "D:\backups\zaki"
param(
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = "Stop"

if (-not $env:DATABASE_URL) { throw "DATABASE_URL غير مضبوط." }
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) { throw "pg_dump غير موجود على PATH." }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dump = Join-Path $OutDir "ai_commerce-$stamp.dump"
$counts = Join-Path $OutDir "ai_commerce-$stamp.counts.json"

Write-Host "نسخ إلى $dump …"
pg_dump --format=custom --no-owner --no-privileges --file="$dump" $env:DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw "فشل pg_dump." }

Write-Host "عدّ الصفوف إلى $counts …"
node --import tsx scripts/db-counts.ts | Out-File -Encoding utf8 $counts

Write-Host "تمت النسخة:"
Get-Item $dump, $counts | Select-Object Name, Length
