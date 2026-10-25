param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$target = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\gmail-credential.xml'
$temporary = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\gmail-credential.pending.xml'
$sender = 'tokyotojjjj@gmail.com'
$stage = 'input'
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Yahoo auction tool - Gmail setup'
$form.ClientSize = New-Object System.Drawing.Size(480, 205)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Text = "Gmail: $sender`r`n`r`nPaste the 16-letter Google APP PASSWORD below.`r`nYour normal Google password is NOT needed."
$label.Location = New-Object System.Drawing.Point(18, 16)
$label.Size = New-Object System.Drawing.Size(445, 78)
$password = New-Object System.Windows.Forms.TextBox
$password.Location = New-Object System.Drawing.Point(18, 100)
$password.Size = New-Object System.Drawing.Size(440, 25)
$password.UseSystemPasswordChar = $true
$count = New-Object System.Windows.Forms.Label
$count.Text = '0 / 16 letters (spaces are ignored)'
$count.Location = New-Object System.Drawing.Point(18, 132)
$count.Size = New-Object System.Drawing.Size(440, 20)
$password.Add_TextChanged({
    $length = ($password.Text -replace '\s', '').Length
    $count.Text = "$length / 16 letters (spaces are ignored)"
})
$save = New-Object System.Windows.Forms.Button
$save.Text = 'Save'
$save.Location = New-Object System.Drawing.Point(270, 155)
$save.Add_Click({
    $value = $password.Text -replace '\s', ''
    if ($value -cnotmatch '^[a-z]{16}$') {
        $count.ForeColor = [System.Drawing.Color]::Firebrick
        $count.Text = "Found $($value.Length) characters. Paste only Google's 16 lowercase letters."
        $password.Focus()
        $password.SelectAll()
    } else {
        $secure = [System.Security.SecureString]::new()
        foreach ($character in $value.ToCharArray()) { $secure.AppendChar($character) }
        $secure.MakeReadOnly()
        $form.Tag = [System.Management.Automation.PSCredential]::new($sender, $secure)
        $password.Clear()
        $form.DialogResult = 'OK'
    }
    $value = $null
})
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(370, 155)
$cancel.DialogResult = 'Cancel'
$form.Controls.AddRange(@($label, $password, $count, $save, $cancel))
$form.AcceptButton = $save
$form.CancelButton = $cancel
$form.Add_Shown({ $password.Focus() })
if ($CheckOnly) {
    if (-not $password.UseSystemPasswordChar -or $form.Controls.Count -ne 5) { throw 'Input form check failed.' }
    $form.Add_Shown({
        $password.Text = 'not-a-password'
        $save.PerformClick()
        if ($form.DialogResult -eq 'OK') { throw 'Invalid input accepted.' }
        $password.Text = 'abcd efgh ijkl mnop'
        if ($count.Text -notlike '16 / 16*') { throw 'Space normalization check failed.' }
        $save.PerformClick()
    })
    if ($form.ShowDialog() -ne 'OK') { throw 'Input submission failed.' }
    if ($form.Tag.Password.Length -ne 16 -or $password.Text.Length -ne 0) { throw 'Credential handoff failed.' }
    $testPath = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.xml')
    try {
        $form.Tag | Export-Clixml -LiteralPath $testPath
        $restored = Import-Clixml -LiteralPath $testPath
        if ($restored.GetNetworkCredential().Password -cne 'abcdefghijklmnop') { throw 'Encrypted round-trip failed.' }
        if ([System.IO.File]::ReadAllText($testPath).Contains('abcdefghijklmnop')) { throw 'Plaintext in encrypted file.' }
    } finally {
        if (Test-Path -LiteralPath $testPath) { Remove-Item -LiteralPath $testPath -Force }
    }
    $form.Dispose()
    Write-Output 'Dummy input -> validation -> secure handoff -> encrypted file -> decryption: OK. No real credentials accessed.'
    exit
}

try {
    if (Test-Path -LiteralPath $target) {
        $answer = [System.Windows.Forms.MessageBox]::Show(
            'Replace the saved Gmail app password?', 'Yahoo auction tool', 'YesNo', 'Question')
        if ($answer -ne 'Yes') { exit }
    }
    if ($form.ShowDialog() -ne 'OK') { exit }
    $stage = 'secure handoff'
    $saved = $form.Tag
    if ($null -eq $saved -or $saved.Password.Length -ne 16) { throw 'Credential handoff failed.' }
    $stage = 'encrypted save'
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    # Windows Export-Clixml protects SecureString with this user's DPAPI key.
    $saved | Export-Clixml -LiteralPath $temporary
    $check = Import-Clixml -LiteralPath $temporary
    if ($check.UserName -ne $sender -or $check.Password.Length -ne 16) { throw 'Could not verify the saved credential.' }
    Move-Item -LiteralPath $temporary -Destination $target -Force
    [System.Windows.Forms.MessageBox]::Show(
        'Saved securely for this Windows user. No email has been sent. Return to Codex and say: Saved.',
        'Yahoo auction tool', 'OK', 'Information') | Out-Null
} catch {
    [System.Windows.Forms.MessageBox]::Show(
        "Setup did not finish at: $stage. No email was sent. No password was shown or logged.",
        'Yahoo auction tool', 'OK', 'Error') | Out-Null
} finally {
    $plain = $null
    $password.Clear()
    $form.Dispose()
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
