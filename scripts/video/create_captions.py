"""Produce SRT and render timings from Athena storyboard narration and SAPI WAVs.

Caption word timing is approximate, distributed across each actual audio duration.
No forced alignment service or external dependency is used.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import textwrap
import wave


LINE_WIDTH = 35
MAX_CUE_CHARACTERS = 70


def split_cues(narration: str) -> list[str]:
    """Prefer clause boundaries, while limiting cues to two readable lines."""
    normalized = " ".join(narration.split())
    words = normalized.split()
    cues: list[str] = []
    current: list[str] = []
    for word in words:
        candidate = " ".join([*current, word])
        wrapped = textwrap.wrap(candidate, width=LINE_WIDTH, break_long_words=False)
        if current and (len(candidate) > MAX_CUE_CHARACTERS or len(wrapped) > 2):
            cues.append(" ".join(current))
            current = []
        current.append(word)
        current_text = " ".join(current)
        if re.search(r"[.!?;:]$", word) and len(current_text) >= 20:
            cues.append(current_text)
            current = []
        elif word.endswith(",") and len(current_text) >= 38:
            cues.append(current_text)
            current = []
    if current:
        cues.append(" ".join(current))
    return cues


def timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    whole_seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{whole_seconds:02},{milliseconds:03}"


def audio_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        if audio.getnframes() <= 0 or audio.getframerate() <= 0:
            raise ValueError(f"Audio file is empty: {path}")
        return audio.getnframes() / audio.getframerate()


def create_outputs(storyboard_path: Path, output_dir: Path, padding: float, fps: int = 24) -> dict:
    storyboard = json.loads(storyboard_path.read_text(encoding="utf-8-sig"))
    scenes = storyboard.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("Storyboard must contain a nonempty scenes array.")
    if padding < 0:
        raise ValueError("Padding must be nonnegative.")
    if fps <= 0:
        raise ValueError("FPS must be a positive integer.")

    timings = []
    captions = []
    narration_sections = []
    cursor = 0.0
    cue_number = 0
    for index, scene in enumerate(scenes, start=1):
        narration = scene.get("narration")
        if not isinstance(narration, str) or not narration.strip():
            raise ValueError(f"Scene {index} has no narration.")
        audio_path = Path("audio") / f"scene-{index:02}.wav"
        duration = audio_duration(output_dir / audio_path)
        duration_frames = math.ceil((duration + padding) * fps)
        scene_duration = duration_frames / fps
        scene_end = cursor + scene_duration
        cues = split_cues(narration)
        total_words = sum(len(cue.split()) for cue in cues)
        consumed_words = 0
        for cue in cues:
            cue_start = cursor + duration * consumed_words / total_words
            consumed_words += len(cue.split())
            cue_end = cursor + duration * consumed_words / total_words
            cue_number += 1
            lines = textwrap.wrap(cue, width=LINE_WIDTH, break_long_words=False)
            captions.append(
                f"{cue_number}\n{timestamp(math.ceil(cue_start * 1000) / 1000)} --> "
                f"{timestamp(math.floor(cue_end * 1000) / 1000)}\n"
                + "\n".join(lines)
                + "\n"
            )
        title = str(scene.get("title", f"Scene {index}"))
        timings.append(
            {
                "index": index,
                "id": scene.get("id", f"scene-{index:02}"),
                "title": title,
                "start_seconds": round(cursor, 6),
                "audio_duration_seconds": round(duration, 6),
                "padding_seconds": padding,
                "effective_padding_seconds": round(scene_duration - duration, 6),
                "duration_frames": duration_frames,
                "duration_seconds": round(scene_duration, 6),
                "end_seconds": round(scene_end, 6),
                "audio_path": audio_path.as_posix(),
                "caption_count": len(cues),
            }
        )
        narration_sections.append(f"{index:02}. {title}\n\n{narration.strip()}")
        cursor = scene_end

    result = {
        "version": 1,
        "voice": "Microsoft Zira Desktop - English (United States)",
        "timing_method": "Actual WAV duration; scene durations round up to whole frames after minimum padding; caption intervals approximate proportional word timing, not forced alignment.",
        "padding_seconds": padding,
        "fps": fps,
        "total_duration_seconds": round(cursor, 6),
        "scene_count": len(timings),
        "caption_count": cue_number,
        "scenes": timings,
    }
    # Read all inputs successfully before replacing outputs.
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "captions.srt").write_text("\n".join(captions), encoding="utf-8")
    (output_dir / "scene-timing.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    narration_title = str(storyboard.get("title", "Athena chapter narration"))
    (output_dir / "narration.txt").write_text(
        narration_title + "\n\n" + "\n\n---\n\n".join(narration_sections) + "\n",
        encoding="utf-8",
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("storyboard", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--padding", type=float, default=0.5)
    parser.add_argument("--fps", type=int, default=24)
    args = parser.parse_args()
    output_dir = args.output_dir or args.storyboard.resolve().parent
    result = create_outputs(args.storyboard, output_dir, args.padding, args.fps)
    print(
        f"Created {result['caption_count']} caption cues for {result['scene_count']} scenes; "
        f"duration {result['total_duration_seconds']:.2f}s (approximate caption timing)."
    )


if __name__ == "__main__":
    main()
