[CmdletBinding()]
param(
    [string]$StoryboardPath = (Join-Path $PSScriptRoot '../../artifacts/videos/diagnostic-imaging/storyboard.json'),
    [string]$OutputDirectory,
    [ValidateSet(-1, 0)]
    [int]$Rate = -1,
    [switch]$SkipCaptions
)

$ErrorActionPreference = 'Stop'
$storyboardFile = (Resolve-Path -LiteralPath $StoryboardPath).Path
if (-not $OutputDirectory) {
    $OutputDirectory = Split-Path -Parent $storyboardFile
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$audioDirectory = Join-Path $outputRoot 'audio'
$storyboard = Get-Content -LiteralPath $storyboardFile -Raw -Encoding UTF8 | ConvertFrom-Json
$scenes = @($storyboard.scenes)
if ($scenes.Count -eq 0) { throw 'Storyboard must contain at least one scene.' }
foreach ($scene in $scenes) {
    if ([string]::IsNullOrWhiteSpace([string]$scene.narration)) {
        throw 'Every storyboard scene must contain nonempty plain-text narration.'
    }
}
[System.IO.Directory]::CreateDirectory($audioDirectory) | Out-Null

$speaker = $null
$voiceTokens = $null
$selectedVoice = $null
try {
    $speaker = New-Object -ComObject SAPI.SpVoice
    $voiceTokens = $speaker.GetVoices()
    for ($voiceIndex = 0; $voiceIndex -lt $voiceTokens.Count; $voiceIndex++) {
        $candidateVoice = $voiceTokens.Item($voiceIndex)
        $description = $candidateVoice.GetDescription()
        if ($description -match 'Microsoft Zira Desktop' -and $description -match 'English.*United States') {
            $selectedVoice = $candidateVoice
            break
        }
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($candidateVoice) | Out-Null
    }
    if ($null -eq $selectedVoice) {
        throw 'Microsoft Zira Desktop English (United States) is unavailable. Install that Windows speech voice before rendering narration.'
    }
    # Set this SAPI instance only. The system default voice is not changed.
    $speaker.Voice = $selectedVoice
    $speaker.Rate = $Rate
    $speaker.Volume = 100
    $sceneNumber = 0
    foreach ($scene in $scenes) {
        $sceneNumber++
        $fileName = 'scene-{0:D2}.wav' -f $sceneNumber
        $audioPath = Join-Path $audioDirectory $fileName
        $temporaryPath = Join-Path $audioDirectory ('scene-{0:D2}.partial.wav' -f $sceneNumber)
        $fileStream = $null
        $streamOpened = $false
        try {
            $fileStream = New-Object -ComObject SAPI.SpFileStream
            $fileStream.Format.Type = 22
            $fileStream.Open($temporaryPath, 3, $false)
            $streamOpened = $true
            $speaker.AudioOutputStream = $fileStream
            # SVSFIsNotXML avoids treating source text as speech markup.
            $speaker.Speak([string]$scene.narration, 16) | Out-Null
            $fileStream.Close()
            $streamOpened = $false
            Move-Item -LiteralPath $temporaryPath -Destination $audioPath -Force
            Write-Output ('Narrated scene {0}: {1}' -f $sceneNumber, [string]$scene.title)
        }
        finally {
            if ($streamOpened -and $null -ne $fileStream) {
                try { $fileStream.Close() } catch { }
            }
            if ($null -ne $fileStream) {
                [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($fileStream) | Out-Null
            }
            if (Test-Path -LiteralPath $temporaryPath) {
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
    }
}
finally {
    if ($null -ne $speaker) { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($speaker) | Out-Null }
    if ($null -ne $selectedVoice) { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($selectedVoice) | Out-Null }
    if ($null -ne $voiceTokens) { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($voiceTokens) | Out-Null }
}

if (-not $SkipCaptions) {
    & python (Join-Path $PSScriptRoot 'create_captions.py') $storyboardFile --output-dir $outputRoot --padding 0.5
    if ($LASTEXITCODE -ne 0) { throw "Caption generation failed with exit code $LASTEXITCODE." }
}
