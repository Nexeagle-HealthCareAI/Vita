# Generates the RAW clean speech WAVs that mix_snr.py then mixes with synthetic noise at
# controlled SNRs. Windows-only (uses the built-in System.Speech SAPI synthesizer -- no
# extra installs). Not run automatically by any test or CI job; run manually and commit
# the results whenever the phrase set changes. See tests/test_real_audio_fixtures.py and
# docs/BUILD_GUIDE.md §3.4 for why these fixtures exist and what they're honestly not
# (TTS-synthesized speech, not real hospital recordings -- none exist, none are
# fabricated-and-mislabeled as real).
#
# Usage: powershell -File generate_fixtures.ps1
# Output: tests/fixtures/_raw/<phraseId>.wav (16kHz mono 16-bit PCM)

Add-Type -AssemblyName System.Speech

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rawDir = Join-Path $scriptDir "_raw"
New-Item -ItemType Directory -Force -Path $rawDir | Out-Null

$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
)

# phraseId -> spoken text. Short, hospital-reception-style dialogue -- representative of
# what a real caller/receptionist utterance sounds like, not sentence-diversity for its
# own sake.
$phrases = [ordered]@{
    "book-appointment"    = "Hello, I would like to book an appointment with Doctor Patel."
    "doctor-availability" = "Is Doctor Sharma available this afternoon?"
    "confirm-appointment" = "Can you confirm my appointment for tomorrow morning?"
    "reschedule-visit"    = "I need to reschedule my visit to next Tuesday."
}

foreach ($id in $phrases.Keys) {
    $outPath = Join-Path $rawDir "$id.wav"
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        $synth.SelectVoice("Microsoft David Desktop")
        $synth.SetOutputToWaveFile($outPath, $format)
        $synth.Speak($phrases[$id])
    } finally {
        $synth.Dispose()
    }
    Write-Host "wrote $outPath"
}

Write-Host "Done. Now run: python mix_snr.py"
