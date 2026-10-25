param([switch]$Send)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$address = 'tokyotojjjj@gmail.com'
$receipt = Join-Path $root 'data\gmail-test-result.json'
$message = $null
$smtp = $null
$attempt = $null
$stage = 'prepare'
try {
    $template = [System.IO.File]::ReadAllText((Join-Path $root 'docs\gmail-test-message.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $message = [System.Net.Mail.MailMessage]::new($address, $address)
    $message.Subject = $template.subject
    $message.Body = $template.body
    $message.SubjectEncoding = [System.Text.Encoding]::UTF8
    $message.BodyEncoding = [System.Text.Encoding]::UTF8
    if ($message.To.Count -ne 1 -or $message.To[0].Address -ne $address -or $message.From.Address -ne $address) { throw 'Invalid recipient.' }
    if (-not $Send) {
        Write-Output 'Preview passed: one recipient, UTF-8 message, no credentials accessed, no email sent.'
        exit 0
    }
    $stage = 'credential'
    $credential = Import-Clixml -LiteralPath (Join-Path $root 'data\gmail-credential.xml')
    if ($credential.UserName -ne $address -or $credential.Password.Length -ne 16) { throw 'Invalid saved credential.' }
    $smtp = [System.Net.Mail.SmtpClient]::new('smtp.gmail.com', 587)
    $smtp.EnableSsl = $true
    $smtp.UseDefaultCredentials = $false
    $smtp.Credentials = $credential.GetNetworkCredential()
    $smtp.Timeout = 30000
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    $stage = 'duplicate guard'
    # CreateNew prevents another run from sending the same approved test again.
    $attempt = [System.IO.File]::Open($receipt, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    function Write-Receipt([string]$status) {
        $record = @{ status = $status; at = [DateTimeOffset]::UtcNow.ToString('o'); recipient = $address; subject = $template.subject } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($record)
        $attempt.Position = 0
        $attempt.SetLength(0)
        $attempt.Write($bytes, 0, $bytes.Length)
        $attempt.Flush($true)
    }
    Write-Receipt 'attempting'
    $stage = 'smtp send'
    $smtp.Send($message)
    $stage = 'receipt'
    Write-Receipt 'smtp_accepted'
    Write-Output 'SMTP_ACCEPTED: one test email accepted by Gmail. Inbox delivery is not yet confirmed.'
} catch {
    if ($null -ne $attempt -and $stage -eq 'smtp send') { Write-Receipt 'failed_or_uncertain' }
    Write-Output "TEST_NOT_CONFIRMED: stage=$stage; no automatic retry. Credentials were not logged."
    exit 1
} finally {
    if ($null -ne $attempt) { $attempt.Dispose() }
    if ($null -ne $smtp) { $smtp.Dispose() }
    if ($null -ne $message) { $message.Dispose() }
    $credential = $null
}
