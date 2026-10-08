# Athena narrated motion-graphics renderer

`render_athena.py` creates an actual 1280 × 720, 24 fps H.264/AAC MP4. The same
original Athena character appears throughout: auburn bun, glasses, teal outfit,
ivory coat, and Athena badge. Gentle pointing, blinking, breathing, speech-energy
mouth motion, animated diagram highlights, moving arrows, and captions are drawn
with Pillow. Illustrations are clearly labelled conceptual schematics and are
never presented as patient imaging.

Requirements: Python, Pillow, and an ffmpeg executable with `libx264` and AAC.
No downloaded character assets, native app packages, or remote services are used
by this renderer. Narration and storyboard generation happen before rendering.

```powershell
python scripts/video/render_athena.py `
  --project artifacts/videos/diagnostic-imaging `
  --ffmpeg C:/path/to/ffmpeg.exe
```

Input structure:

```text
diagnostic-imaging/
  storyboard.json
  captions.srt             # optional global cues, including scene padding
  audio/
    scene-01.wav            # PCM WAV, indexed in storyboard order
    scene-02.wav
    ...
```

Storyboard example:

```json
{
  "title": "Athena explains diagnostic imaging",
  "subtitle": "A surgical-principles lesson",
  "scenes": [
    {
      "id": "opening",
      "type": "intro",
      "title": "Start with the clinical question",
      "subtitle": "Choose an investigation that changes management.",
      "bullets": ["Ask", "Investigate", "Act"],
      "narration": "Your original reviewed narration goes here."
    }
  ]
}
```

Supported scene types: `intro`, `toolkit`, `choice`, `case`, `prior`, `request`,
`interpret`, `checklist`, `contrast`, `kidney`, `quiz`, `recap`. Each scene needs a
nonempty narration and title. Use concise subtitles and no more than three short
bullets; text is wrapped and constrained to safe areas. The design assumes a
diagnostic-imaging lesson. Other chapters should add original diagram templates
rather than reuse anatomically irrelevant illustrations.

`checklist` optionally accepts `checks` (up to six short labels). `quiz` optionally
accepts `question`, `options` (up to three strings or `{ "label": "A", "text":
"..." }`), and `answer` (`"A"`, `"B"`, `"C"`, or zero-based index). A supplied
answer is highlighted at the supplied caption cue containing "correct answer is"
when one is available, or after `reveal_after` (default `0.68`) of the scene
duration. Caption-driven reveal remains approximate when cue timings are
approximate. The renderer does not invent a correct answer.

Each scene's duration is its WAV duration plus 0.5 seconds, rounded up to the next
24 fps frame. If `captions.srt` exists it is used directly; its global timing must
include those scene boundaries. Without it, narration is split into short phrase
cues with word-proportional timings. These are **approximate cues**, not a forced
alignment or transcription. `--approximate-captions` explicitly ignores supplied
cues. Burned-in captions are always readable and a soft caption track is also
embedded in the final MP4.

Outputs:

- `athena-diagnostic-imaging-draft.mp4`, with fast-start metadata.
- `poster.png`, `probe-scene-01.png` etc., and `contact-sheet.png` for visual QA.
- `video-metadata.json`, with actual audio/scene timing and caption provenance.
- `captions-approximate.srt` when fallback timing is used.
- Small encoder logs and concat instructions in `.render-cache/`.

The renderer streams lossless PNG frames to ffmpeg and encodes one scene at a
time, reducing pipe traffic on Windows. The pipe first encodes video alone, then
the WAV is muxed from a separate file input; this avoids multi-input scheduling
backpressure during long narrated scenes. `--transport raw` selects uncompressed
RGB piping. It does not save large uncompressed frame sequences. Scene MP4s are
removed after a successful join; pass `--keep-clips` to retain them. Every frame
and the filename explicitly identify the result as an educational draft pending
medical review. A successful render is not editorial or medical approval.

`--resume --keep-clips` reuses finished scenes only when their stored source
fingerprints and MP4 checksums match. Fingerprints include narration audio,
storyboard scene content, caption cues, durations, dimensions, frame rate and
encoding quality. Bump the renderer's template version when changing visuals.
Unverified or incomplete clips are rendered again.
