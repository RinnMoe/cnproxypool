param(
  [Parameter(Mandatory = $true)]
  [string]$Proxy,

  [string[]]$Url = @("https://api.ipify.org", "https://ipinfo.io/ip", "https://ifconfig.me/ip"),
  [int]$ConnectTimeout = 8,
  [int]$MaxTime = 15
)

$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

if ($Proxy -notmatch "^[a-zA-Z][a-zA-Z0-9+.-]*://") {
  $Proxy = "http://$Proxy"
}

foreach ($target in $Url) {
  $result = & curl.exe -x $Proxy --connect-timeout $ConnectTimeout --max-time $MaxTime --show-error --silent --write-out "`n%{http_code}" $target 2>&1
  if ($LASTEXITCODE -eq 0 -and $result.Count -gt 0) {
    $status = [string]($result | Select-Object -Last 1)
    $body = @($result | Select-Object -SkipLast 1)
    if ($status -match "^[23]\d\d$") {
      $ip = ($body | Select-Object -First 1).Trim()
      Write-Output $ip
      Write-Host "OK: proxy can access $target with valid TLS."
      exit 0
    }
    $lastError = "HTTP $status from $target"
  } else {
    $lastError = $result
  }
}

Write-Host "FAILED: proxy is not suitable for HTTPS use." -ForegroundColor Red
$lastError | Write-Host
exit 1
