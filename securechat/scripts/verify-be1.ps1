param(
    [string]$Project = 'securechat-be1',
    [string]$BaseA = 'http://localhost:8081',
    [string]$BaseB = 'http://localhost:8082',
    [string]$Report = 'docs/experiments/be1-outage.json'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
function Invoke-Compose {
    param([string[]]$Arguments)
    & docker compose -p $Project @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose command failed' }
}
function Invoke-API {
    param([string]$Base, [string]$Method, [string]$Path, [string]$Token, $Body)
    $headers = @{}
    if ($Token) { $headers.Authorization = 'Bearer ' + $Token }
    $parameters = @{ Uri = $Base + $Path; Method = $Method; Headers = $headers; TimeoutSec = 15 }
    if ($null -ne $Body) { $parameters.Body = ($Body | ConvertTo-Json -Depth 8 -Compress); $parameters.ContentType = 'application/json' }
    Invoke-RestMethod @parameters
}
function Get-Backlog {
    $values = @()
    foreach ($base in @($BaseA, $BaseB)) {
        $metrics = (Invoke-WebRequest -UseBasicParsing -Uri ($base + '/metrics') -TimeoutSec 10).Content
        $match = [regex]::Match($metrics, '(?m)^securechat_outbox_backlog ([0-9.eE+-]+)')
        if (!$match.Success) { throw 'Missing backlog metric' }
        $value = [double]::Parse($match.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
        if ([regex]::IsMatch($metrics, '(?m)^securechat_outbox_relay_leader 1\r?$')) { return $value }
        $values += $value
    }
    # During election, neither process has yet observed leadership.
    ($values | Measure-Object -Maximum).Maximum
}
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$password = 'local-test-' + [Guid]::NewGuid().ToString('N')
$alice = Invoke-API $BaseA POST '/v1/auth/register' '' @{ username = 'oa_' + $suffix; password = $password }
$bob = Invoke-API $BaseB POST '/v1/auth/register' '' @{ username = 'ob_' + $suffix; password = $password }
$conversation = Invoke-API $BaseA POST '/v1/conversations' $alice.accessToken @{ peerUserId = $bob.userId }
$accepted = @()
$restarted = $false
try {
    Invoke-Compose -Arguments @('stop', 'kafka')
    # Verify an API instance can restart while Kafka is down.
    Invoke-Compose -Arguments @('restart', 'backend-a')
    $deadline = [DateTime]::UtcNow.AddSeconds(40)
    do {
        try { $ready = Invoke-API $BaseA GET '/readyz' '' $null; break } catch { Start-Sleep -Milliseconds 250 }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$ready -or $ready.status -ne 'ready') { throw 'API cannot start with Kafka unavailable' }
    for ($index = 0; $index -lt 5; $index++) {
        $clientId = [Guid]::NewGuid().ToString()
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes)
        $rng.Dispose()
        $payload = @{ clientMessageId = $clientId; ciphertext = [Convert]::ToBase64String($bytes); protocolMeta = @{ type = 3 } }
        $message = Invoke-API $BaseA POST ('/v1/conversations/' + $conversation.id + '/messages') $alice.accessToken $payload
        if ($message.state -ne 'accepted') { throw 'No durable acceptance during outage' }
        $retry = Invoke-API $BaseA POST ('/v1/conversations/' + $conversation.id + '/messages') $alice.accessToken $payload
        if (!$retry.duplicate -or $retry.messageId -ne $message.messageId) { throw 'Retry created a duplicate' }
        $accepted += $message
    }
    $null = Invoke-API $BaseB POST ('/v1/messages/' + $accepted[0].messageId + '/receipts') $bob.accessToken @{ state = 'read' }
    $sync = Invoke-API $BaseB POST '/v1/sync' $bob.accessToken @{ cursors = @{} }
    $page = @($sync.conversations | Where-Object conversationId -eq $conversation.id)
    if ($page.Count -ne 1 -or $page[0].messages.Count -ne 5) { throw 'Offline sync failed while Kafka was down' }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do { $backlog = Get-Backlog; if ($backlog -ge 6) { break }; Start-Sleep -Milliseconds 250 } while ([DateTime]::UtcNow -lt $deadline)
    if ($backlog -lt 6) { throw 'Expected pending messages and receipt in outbox' }
    $recoveryStarted = [DateTime]::UtcNow
    Invoke-Compose -Arguments @('start', 'kafka')
    $restarted = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do { $remaining = Get-Backlog; if ($remaining -eq 0) { break }; Start-Sleep -Milliseconds 250 } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining -ne 0) { throw 'Outbox failed to drain after recovery' }
    $receiptSync = Invoke-API $BaseA POST '/v1/sync' $alice.accessToken @{ cursors = @{ ($conversation.id) = 5 }; receiptCursors = @{} }
    $receipts = @($receiptSync.conversations | Where-Object conversationId -eq $conversation.id)[0].receipts
    if ($receipts.Count -ne 1 -or $receipts[0].state -ne 'read') { throw 'Late receipt missing from sender sync' }
    $history = Invoke-API $BaseB GET ('/v1/conversations/' + $conversation.id + '/messages?limit=50') $bob.accessToken $null
    $uniqueIds = @($history.messages.messageId | Sort-Object -Unique)
    if ($uniqueIds.Count -ne 5 -or $history.messages.Count -ne 5) { throw 'History contains loss or duplicates' }
    $reportData = [ordered]@{
        at = [DateTime]::UtcNow.ToString('o'); project = $Project; passed = $true
        accepted = 5; receiptEvents = 1; backlogDuringOutage = $backlog; backlogAfterRecovery = $remaining
        apiRestartedDuringOutage = $true; databaseSyncDuringOutage = $true; uniqueHistoryMessages = 5
        recoverySecondsIncludingBrokerStartCommand = ([DateTime]::UtcNow - $recoveryStarted).TotalSeconds
        limitation = 'Opaque fixture bytes; no claim of Signal encryption or live client deduplication.'
    }
    $reportPath = [IO.Path]::GetFullPath((Join-Path (Get-Location) $Report))
    New-Item -ItemType Directory -Path (Split-Path -Parent $reportPath) -Force | Out-Null
    [IO.File]::WriteAllText($reportPath, ($reportData | ConvertTo-Json -Depth 5))
    Write-Output ('PASS: outage/restart/recovery, report: ' + $reportPath)
} finally {
    if (!$restarted) { Invoke-Compose -Arguments @('start', 'kafka') }
}
