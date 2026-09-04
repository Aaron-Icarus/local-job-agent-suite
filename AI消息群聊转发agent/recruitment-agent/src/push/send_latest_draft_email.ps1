param(
  [Parameter(Mandatory=$true)]
  [string]$ReportPath,
  [string]$Subject = "岗位搜索汇总"
)

function Get-EnvValue {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if ($value) { return $value }
  }
  return $null
}

$smtpHost = Get-EnvValue @("SMTP_HOST", "EMAIL_HOST")
$smtpPort = Get-EnvValue @("SMTP_PORT", "EMAIL_PORT")
$smtpUser = Get-EnvValue @("SMTP_USER", "EMAIL_USER", "MAIL_USER")
$smtpPass = Get-EnvValue @("SMTP_PASSWORD", "SMTP_PASS", "EMAIL_PASSWORD", "MAIL_PASS")
$mailTo = Get-EnvValue @("MAIL_TO", "EMAIL_TO", "REPORT_EMAIL_TO")
$mailFrom = Get-EnvValue @("MAIL_FROM", "EMAIL_FROM", "REPORT_EMAIL_FROM")
$mailCc = Get-EnvValue @("MAIL_CC", "EMAIL_CC")
$mailBcc = Get-EnvValue @("MAIL_BCC", "EMAIL_BCC")

foreach ($pair in @(
  @("SMTP_HOST", $smtpHost),
  @("SMTP_PORT", $smtpPort),
  @("SMTP_USER", $smtpUser),
  @("SMTP_PASSWORD", $smtpPass),
  @("MAIL_TO", $mailTo)
)) {
  if (-not $pair[1]) { throw "Missing environment variable: $($pair[0])" }
}

if (-not $mailFrom) { $mailFrom = $smtpUser }
$body = Get-Content -Raw -LiteralPath $ReportPath
$message = New-Object System.Net.Mail.MailMessage
$message.From = $mailFrom
$mailTo.Split(",") | ForEach-Object {
  $addr = $_.Trim()
  if ($addr) { [void]$message.To.Add($addr) }
}
if ($mailCc) {
  $mailCc.Split(",") | ForEach-Object {
    $addr = $_.Trim()
    if ($addr) { [void]$message.CC.Add($addr) }
  }
}
if ($mailBcc) {
  $mailBcc.Split(",") | ForEach-Object {
    $addr = $_.Trim()
    if ($addr) { [void]$message.Bcc.Add($addr) }
  }
}
$message.Subject = $Subject
$message.Body = $body
$message.IsBodyHtml = $false

$client = New-Object System.Net.Mail.SmtpClient($smtpHost, [int]$smtpPort)
$secure = Get-EnvValue @("SMTP_SECURE", "EMAIL_SECURE")
$client.EnableSsl = if ($secure) { $secure.ToLower() -ne "false" } else { $true }
$client.Credentials = New-Object System.Net.NetworkCredential($smtpUser, $smtpPass)
$client.Send($message)

Write-Output "Email sent"
