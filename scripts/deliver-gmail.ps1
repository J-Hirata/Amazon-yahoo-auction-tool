param([Parameter(Mandatory=$true)][string]$DataDirectory, [switch]$Preview)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$address = 'tokyotojjjj@gmail.com'
$smtp = $null
$message = $null
$handle = $null
$stage = 'prepare'
$result = @{status='failed'}
try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($payload.id -cnotmatch '^[a-f0-9-]{36}$' -or $payload.subject -match '[\r\n]' -or $payload.subject.Length -gt 200 -or -not $payload.subject -or $payload.text.Length -gt 200000 -or -not $payload.text) { throw 'Invalid message.' }
    if ($Preview) {
        @{status='preview'; valid=$true; sent=$false} | ConvertTo-Json -Compress
        exit 0
    }
    $directory = Join-Path $DataDirectory 'mail-receipts'
    $file = Join-Path $directory ($payload.id + '.json')
    if ([System.IO.File]::Exists($file)) {
        $stage = 'receipt'
        $old = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($old.status -eq 'smtp_accepted') { $result.status = 'smtp_accepted' }
        elseif ($old.status -eq 'failed') { $result.status = 'failed' }
        else { $result.status = 'uncertain' }
    } else {
        $credential = Import-Clixml -LiteralPath (Join-Path $DataDirectory 'gmail-credential.xml')
        if ($credential.UserName -ne $address -or $credential.Password.Length -ne 16) { throw 'Invalid credential.' }
        $message = [System.Net.Mail.MailMessage]::new($address, $address)
        $message.Subject = $payload.subject
        $message.Body = $payload.text
        $message.SubjectEncoding = [System.Text.Encoding]::UTF8
        $message.BodyEncoding = [System.Text.Encoding]::UTF8
        $message.Headers.Add('Message-ID', ('<' + $payload.id + '@asin-yahoo.local>'))
        $smtp = [System.Net.Mail.SmtpClient]::new('smtp.gmail.com', 587)
        $smtp.EnableSsl = $true
        $smtp.UseDefaultCredentials = $false
        $smtp.Credentials = $credential.GetNetworkCredential()
        $smtp.Timeout = 30000
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        $stage = 'receipt'
        $handle = [System.IO.File]::Open($file, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        function Save-Receipt([string]$status) {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes((@{status=$status; at=[DateTimeOffset]::UtcNow.ToString('o')} | ConvertTo-Json -Compress))
            $handle.Position = 0
            $handle.SetLength(0)
            $handle.Write($bytes, 0, $bytes.Length)
            $handle.Flush($true)
        }
        Save-Receipt 'attempting'
        $stage = 'send'
        $smtp.Send($message)
        $stage = 'accepted'
        Save-Receipt 'smtp_accepted'
        $result.status = 'smtp_accepted'
    }
} catch {
    $result.status = 'failed'
    if ($stage -eq 'send') {
        $result.status = 'uncertain'
        $exception = $_.Exception
        while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
        # An explicit SMTP rejection is safe to retry; a timeout may follow acceptance.
        if ($exception -is [System.Net.Mail.SmtpException] -and [int]$exception.StatusCode -ge 400) { $result.status = 'failed' }
    }
    if ($stage -eq 'accepted' -or $stage -eq 'receipt') { $result.status = 'uncertain' }
    if ($null -ne $handle) { try {Save-Receipt $result.status} catch { $result.status = 'uncertain' } }
} finally {
    if ($null -ne $handle) {$handle.Dispose()}
    if ($null -ne $smtp) {$smtp.Dispose()}
    if ($null -ne $message) {$message.Dispose()}
    $credential = $null
    $payload = $null
}
$result | ConvertTo-Json -Compress
