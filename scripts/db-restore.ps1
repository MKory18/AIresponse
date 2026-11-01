# استرجاع نسخة قاعدة بيانات سيستم ٧ إلى قاعدة هدف (مخصّصة للاسترجاع، ليست الإنتاج)
# الاستخدام:  .\scripts\db-restore.ps1 -Dump "…dump" -TargetUrl "postgresql://…/ai_commerce_restore"
param(
  [Parameter(Mandatory = $true)][string]$Dump,
  [Parameter(Mandatory = $true)][string]$TargetUrl
)
$ErrorActionPreference = "Stop"

if (-not (Get-Command pg_restore -ErrorAction SilentlyContinue)) { throw "pg_restore غير موجود على PATH." }
if (-not (Test-Path $Dump)) { throw "ملف النسخة غير موجود: $Dump" }

Write-Host "استرجاع $Dump إلى قاعدة الهدف (--clean --if-exists) …"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TargetUrl" "$Dump"
# pg_restore قد يرجع رمزًا غير صفري لأخطاء غير قاتلة (فروقات صلاحيات) — نتحقق بالعدّ.
Write-Host "انتهى pg_restore (تحقق بعدّ الصفوف قبل الاعتماد)."
