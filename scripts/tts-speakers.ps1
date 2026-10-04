$voice = New-Object -ComObject SAPI.SpVoice
$voices = @($voice.GetVoices() | ForEach-Object {
  [PSCustomObject]@{ id = $_.Id; name = $_.GetDescription(); culture = 'system' }
})
$voices | ConvertTo-Json -Compress
