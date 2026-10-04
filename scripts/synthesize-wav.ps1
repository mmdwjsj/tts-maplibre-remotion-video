param([Parameter(Mandatory=$true)][string]$TextPath,[Parameter(Mandatory=$true)][string]$OutputPath,[string]$VoiceName='',[double]$TargetSeconds=3,[int]$Rate=0)
$text = [IO.File]::ReadAllText($TextPath,[Text.Encoding]::UTF8)
if ([string]::IsNullOrWhiteSpace($text)) { throw 'TTS text is empty.' }
$voice = New-Object -ComObject SAPI.SpVoice
if ($VoiceName) {
  $selected = @($voice.GetVoices() | Where-Object { $_.Id -eq $VoiceName -or $_.GetDescription() -eq $VoiceName } | Select-Object -First 1)
  if ($selected.Count -gt 0) { $voice.Voice = $selected[0] }
}
$estimated=[Math]::Max(.5,$text.Length/12.0); $parts=[Math]::Max(1,($text -split "`n`n").Count); $ratio=$estimated/[Math]::Max(.5,$TargetSeconds*$parts)
$automaticRate=[int][Math]::Round([Math]::Log($ratio,1.18)); $voice.Rate=[Math]::Max(-10,[Math]::Min(10,$automaticRate+$Rate))
$stream = New-Object -ComObject SAPI.SpFileStream
$format = New-Object -ComObject SAPI.SpAudioFormat
$format.Type = 22
$stream.Format = $format
try { $stream.Open($OutputPath,3,$false); $voice.AudioOutputStream=$stream; [void]$voice.Speak($text) } finally { $stream.Close() }


