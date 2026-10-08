#!/usr/bin/env python3
"""Render original Athena educational motion graphics with pre-recorded narration.

No remote requests, medical-image synthesis, or stock artwork. Pillow draws each
frame; ffmpeg encodes bounded, per-scene streams and joins the finished video.
"""
from __future__ import annotations

import argparse
import array
import json
import io
import hashlib
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import wave

from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT, FPS = 1280, 720, 24
INK = "#102D36"
TEAL = "#117F85"
PALE_TEAL = "#D2EDE8"
GOLD = "#EBC66C"
IVORY = "#F7F3E9"
MUTED = "#B3CBCB"
DARK = "#0A202A"
WHITE = "#FFFFFF"
HAIR = "#4A2926"
SKIN = "#DFA986"
PAPER_INK = "#264F59"
KINDS = {
    "intro", "toolkit", "choice", "case", "prior", "request", "interpret",
    "checklist", "contrast", "kidney", "quiz", "recap",
}
FONT_CACHE: dict[tuple[int, bool], ImageFont.FreeTypeFont] = {}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    key = (size, bold)
    if key not in FONT_CACHE:
        candidates = [
            Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / ("segoeuib.ttf" if bold else "segoeui.ttf"),
            Path("/usr/share/fonts/truetype/dejavu") / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"),
        ]
        face = next((p for p in candidates if p.exists()), None)
        if face is None:
            raise RuntimeError("Install Segoe UI or DejaVu Sans for readable video text.")
        FONT_CACHE[key] = ImageFont.truetype(str(face), size)
    return FONT_CACHE[key]


def wrap(draw: ImageDraw.ImageDraw, text: str, max_width: int, size: int, bold: bool = False) -> list[str]:
    lines: list[str] = []
    for paragraph in str(text).split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        line = words.pop(0)
        for word in words:
            trial = line + " " + word
            if draw.textlength(trial, font=font(size, bold)) <= max_width:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def textblock(draw, xy, text, width, size=24, fill=INK, bold=False, line_height=None, max_lines=None):
    lines = wrap(draw, text, width, size, bold)
    if max_lines is not None and len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while draw.textlength(last + "…", font=font(size, bold)) > width and last:
            last = last[:-1]
        lines[-1] = last.rstrip() + "…"
    line_height = line_height or round(size * 1.3)
    for idx, line in enumerate(lines):
        draw.text((xy[0], xy[1] + idx * line_height), line, font=font(size, bold), fill=fill)
    return len(lines) * line_height


def centered(draw, xy, text, size=24, fill=INK, bold=False):
    length = draw.textlength(str(text), font=font(size, bold))
    draw.text((xy[0] - length / 2, xy[1]), str(text), font=font(size, bold), fill=fill)


def rr(draw, box, fill, radius=18, outline=None, width=2):
    draw.rounded_rectangle(tuple(round(v) for v in box), radius=radius, fill=fill, outline=outline, width=width)


def arrow(draw, start, end, fill=TEAL, width=6, head=13):
    draw.line([start, end], fill=fill, width=width)
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    p1 = (end[0] - head * math.cos(angle - .5), end[1] - head * math.sin(angle - .5))
    p2 = (end[0] - head * math.cos(angle + .5), end[1] - head * math.sin(angle + .5))
    draw.polygon([end, p1, p2], fill=fill)


def step_arrow(draw, start, end, progress, fill=GOLD, radius=7):
    progress = progress % 1
    x = start[0] + (end[0] - start[0]) * progress
    y = start[1] + (end[1] - start[1]) * progress
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def tick(draw, x, y, fill=TEAL, size=14, width=4):
    draw.line([(x - size / 2, y), (x - 1, y + size / 2), (x + size, y - size)], fill=fill, width=width)


def warning(draw, x, y, size=25):
    draw.polygon([(x, y - size), (x - size, y + size), (x + size, y + size)], fill=GOLD)
    centered(draw, (x, y - size + 6), "!", 27, INK, True)


def make_background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        ratio = y / HEIGHT
        color = tuple(round(a + (b - a) * ratio) for a, b in zip((9, 30, 41), (20, 62, 70)))
        draw.line((0, y, WIDTH, y), fill=color)
    for x in range(-250, WIDTH + 250, 86):
        draw.line((x, 0, x + 360, HEIGHT), fill="#173B44", width=1)
    for x in range(50, WIDTH, 80):
        for y in range(200, 600, 80):
            draw.ellipse((x, y, x + 2, y + 2), fill="#2D535B")
    return image


BACKGROUND = make_background()


def tool_icon(draw, kind, x, y, active=False):
    """Original, deliberately schematic equipment and anatomy pictograms."""
    color = TEAL if active else PAPER_INK
    if kind == "Radiograph":
        rr(draw, (x - 42, y - 45, x + 42, y + 43), color, 9)
        draw.line((x, y - 30, x, y + 30), fill=IVORY, width=4)
        for dy in (-17, -6, 6, 18):
            draw.arc((x - 29, y + dy - 17, x + 29, y + dy + 8), 10, 170, fill=IVORY, width=4)
    elif kind == "Ultrasound":
        rr(draw, (x - 46, y - 44, x + 26, y + 17), color, 7)
        rr(draw, (x - 37, y - 34, x + 17, y + 6), PALE_TEAL, 3)
        draw.line((x - 20, y + 17, x - 20, y + 30), fill=color, width=5)
        draw.line((x - 42, y + 32, x + 5, y + 32), fill=color, width=5)
        draw.line([(x + 26, y - 9), (x + 45, y + 3), (x + 39, y + 20)], fill=color, width=4)
        rr(draw, (x + 28, y + 17, x + 46, y + 42), color, 5)
    elif kind == "CT":
        draw.ellipse((x - 44, y - 46, x + 44, y + 39), fill=color)
        draw.ellipse((x - 25, y - 27, x + 25, y + 21), fill=IVORY)
        rr(draw, (x - 40, y + 5, x + 6, y + 18), GOLD, 4)
        draw.line((x - 32, y + 18, x - 32, y + 40), fill=color, width=5)
        draw.line((x + 32, y + 20, x + 32, y + 43), fill=color, width=5)
    elif kind == "MRI":
        rr(draw, (x - 48, y - 41, x + 47, y + 40), color, 29)
        draw.ellipse((x - 31, y - 28, x + 30, y + 26), fill=IVORY)
        draw.ellipse((x - 19, y - 18, x + 19, y + 15), fill=PALE_TEAL)
        draw.line((x - 42, y + 5, x + 5, y + 5), fill=GOLD, width=10)
        centered(draw, (x + 27, y - 24), "N", 14, IVORY, True)


def header(draw, scene, index, total):
    rr(draw, (48, 35, 89, 76), GOLD, 11)
    centered(draw, (69, 39), "A", 27, INK, True)
    draw.text((104, 42), "ATHENA", font=font(23, True), fill=IVORY)
    draw.text((240, 45), "DIAGNOSTIC IMAGING · SURGICAL PRINCIPLES", font=font(17), fill=MUTED)
    rr(draw, (1100, 40, 1232, 72), "#24535C", 12)
    centered(draw, (1166, 46), f"{index:02d} / {total:02d}", 17, IVORY, True)
    textblock(draw, (48, 99), scene.get("title", "Diagnostic imaging"), 1120, 37, IVORY, True, 45, 2)
    rr(draw, (48, 191, 958, 581), IVORY, 24)
    rr(draw, (986, 191, 1232, 581), "#1A444D", 24, "#3D6268")
    centered(draw, (1109, 551), "ATHENA", 19, GOLD, True)
    draw.text((61, 558), "CONCEPTUAL SCHEMATIC", font=font(11, True), fill="#54717A")
    draw.text((48, 690), "Educational draft · medical review pending", font=font(14), fill=MUTED)
    centered(draw, (1138, 690), "Original Athena animation", 12, MUTED)


def card(draw, box, title, subtitle="", accent=TEAL, title_size=23):
    rr(draw, box, "#FFFFFF", 16, "#D4DEDA")
    rr(draw, (box[0], box[1], box[0] + 7, box[3]), accent, 3)
    offset = textblock(draw, (box[0] + 20, box[1] + 14), title, int(box[2] - box[0] - 35), title_size, INK, True, max_lines=2)
    if subtitle:
        textblock(draw, (box[0] + 20, box[1] + 18 + offset), subtitle, int(box[2] - box[0] - 35), 18, PAPER_INK, max_lines=3)


def visual_base(scene):
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    kind = scene["type"]
    subtitle = str(scene.get("subtitle", ""))
    bullets = [str(b) for b in scene.get("bullets", [])][:3]
    if subtitle and kind not in ("quiz", "recap"):
        textblock(draw, (72, 211), subtitle, 850, 23, INK, True, 29, 2)
    if kind == "intro":
        labels = [("Clinical question", "Start with the patient"), ("Imaging answer", "Choose the right tool"), ("Management", "Use the answer to act")]
        for idx, (title, desc) in enumerate(labels):
            x = 83 + idx * 284
            card(draw, (x, 316, x + 250, 472), title, desc)
            centered(draw, (x + 125, 277), ["?", "⌕", "✓"][idx], 36, TEAL, True)
            if idx < 2:
                arrow(draw, (x + 255, 391), (x + 280, 391), TEAL, 4, 9)
    elif kind == "toolkit":
        for idx, label in enumerate(("Radiograph", "Ultrasound", "CT", "MRI")):
            x = 85 + idx * 214
            rr(draw, (x, 294, x + 192, 493), WHITE, 16, "#D4DEDA")
            tool_icon(draw, label, x + 96, 364)
            centered(draw, (x + 96, 427), label, 24, INK, True)
            desc = ("X-rays", "Sound waves", "X-ray slices", "Magnetic field")[idx]
            centered(draw, (x + 96, 464), desc, 17, PAPER_INK)
    elif kind == "choice":
        rr(draw, (85, 296, 410, 484), TEAL, 18)
        centered(draw, (247, 318), "ONE GOOD QUESTION", 22, IVORY, True)
        textblock(draw, (108, 365), "Will this test change what we do?", 274, 30, WHITE, True, 38, 3)
        arrow(draw, (428, 390), (474, 390), TEAL, 6)
        for idx, label in enumerate(bullets or ["Diagnostic value", "Patient risk", "Resources and expertise"]):
            card(draw, (496, 289 + idx * 83, 922, 361 + idx * 83), label, title_size=21)
    elif kind == "case":
        rr(draw, (82, 291, 449, 533), PALE_TEAL, 18)
        # Gallbladder and a simple biliary tree: schematic, never a simulated scan.
        draw.line([(243, 314), (243, 353), (286, 388), (287, 486)], fill=TEAL, width=12)
        draw.line([(171, 327), (210, 348), (243, 353), (300, 327)], fill=TEAL, width=10)
        draw.ellipse((132, 377, 229, 489), fill="#70AEA1", outline=TEAL, width=4)
        draw.line([(209, 394), (245, 359)], fill=TEAL, width=9)
        for x, y in ((164, 433), (188, 457), (171, 470)):
            draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=GOLD, outline=INK, width=1)
        centered(draw, (267, 501), "Gallbladder schematic", 18, PAPER_INK)
        tool_icon(draw, "Ultrasound", 385, 350)
        for idx, label in enumerate(bullets or ["Match symptoms to the question", "Ultrasound may be sufficient", "Escalate if the answer is unclear"]):
            card(draw, (486, 295 + idx * 80, 920, 365 + idx * 80), label, title_size=21)
    elif kind == "prior":
        for idx in range(3):
            x = 129 + idx * 16
            y = 313 - idx * 14
            rr(draw, (x, y, x + 198, y + 174), WHITE, 12, "#AFC5C5")
            draw.line((x + 25, y + 46, x + 167, y + 46), fill=MUTED, width=7)
            draw.line((x + 25, y + 78, x + 144, y + 78), fill=PALE_TEAL, width=7)
        centered(draw, (258, 408), "PRIOR IMAGING", 19, TEAL, True)
        arrow(draw, (394, 381), (484, 381), TEAL, 7)
        rr(draw, (520, 293, 884, 489), PALE_TEAL, 18)
        centered(draw, (702, 318), "COMPARE FIRST", 28, INK, True)
        for idx, label in enumerate(bullets or ["What has changed?", "Can repetition be avoided?", "Does this improve the decision?"]):
            tick(draw, 552, 381 + idx * 33, size=10, width=3)
            textblock(draw, (579, 363 + idx * 39), label, 275, 17, PAPER_INK, line_height=19, max_lines=2)
    elif kind == "request":
        rr(draw, (95, 286, 470, 528), WHITE, 16, "#C7D8D3")
        rr(draw, (184, 271, 382, 308), TEAL, 10)
        centered(draw, (282, 277), "IMAGING REQUEST", 20, IVORY, True)
        for idx, label in enumerate(["Clinical problem", "Relevant history", "Safety information"]):
            draw.ellipse((119, 333 + idx * 58, 149, 363 + idx * 58), fill=PALE_TEAL)
            tick(draw, 132, 348 + idx * 58, size=7, width=3)
            draw.text((169, 329 + idx * 58), label, font=font(22, True), fill=INK)
        for idx, label in enumerate(bullets or ["State the question clearly", "Share relevant risks and history", "Discuss uncertainty with radiology"]):
            card(draw, (514, 292 + idx * 79, 922, 361 + idx * 79), label, title_size=21)
    elif kind == "interpret":
        rr(draw, (85, 284, 453, 533), "#E2ECE4", 18)
        # Two simplified long bones; an intentionally non-diagnostic drawing.
        for x, tilt in ((239, -5), (300, 8)):
            draw.line((x, 326, x + tilt, 485), fill=WHITE, width=24)
            draw.ellipse((x - 22, 308, x + 22, 344), fill=WHITE, outline="#8BA6A2", width=2)
            draw.ellipse((x + tilt - 18, 470, x + tilt + 18, 506), fill=WHITE, outline="#8BA6A2", width=2)
            draw.line((x - 12, 348, x + tilt - 12, 469), fill="#8BA6A2", width=2)
            draw.line((x + 12, 348, x + tilt + 12, 469), fill="#8BA6A2", width=2)
        centered(draw, (269, 510), "Simplified long-bone anatomy", 17, PAPER_INK)
        for idx, label in enumerate(bullets or ["Alignment and bone cortex", "Joints and soft tissues", "Every available view"]):
            card(draw, (494, 292 + idx * 80, 922, 362 + idx * 80), label, title_size=21)
    elif kind == "checklist":
        labels = scene.get("checks") or ["Identity", "Site + side", "Coverage", "Image quality", "Compare", "Conclude"]
        for idx, label in enumerate(labels[:6]):
            col, row = idx % 3, idx // 3
            x, y = 84 + col * 286, 289 + row * 121
            rr(draw, (x, y, x + 266, y + 102), WHITE, 16, "#D4DEDA")
            draw.ellipse((x + 17, y + 24, x + 66, y + 73), fill=PALE_TEAL)
            centered(draw, (x + 41, y + 29), str(idx + 1), 26, TEAL, True)
            textblock(draw, (x + 81, y + 28), str(label), 168, 23, INK, True, max_lines=2)
    elif kind == "contrast":
        rr(draw, (88, 285, 418, 532), PALE_TEAL, 18)
        draw.line((157, 316, 157, 500), fill=PAPER_INK, width=6)
        draw.line((139, 317, 266, 317), fill=PAPER_INK, width=6)
        rr(draw, (221, 332, 299, 407), WHITE, 12, TEAL, 3)
        rr(draw, (231, 364, 289, 397), "#73B7BD", 7)
        draw.line([(260, 407), (260, 450), (321, 482)], fill=TEAL, width=5)
        centered(draw, (255, 493), "Contrast schematic", 18, PAPER_INK)
        warning(draw, 363, 354, 26)
        for idx, label in enumerate(bullets or ["Check previous reactions", "Assess kidney function when relevant", "Use the local safety protocol"]):
            card(draw, (454, 291 + idx * 80, 921, 362 + idx * 80), label, title_size=21)
    elif kind == "kidney":
        rr(draw, (88, 289, 423, 531), PALE_TEAL, 18)
        for x, mirror in ((205, 1), (313, -1)):
            draw.ellipse((x - 40, 335, x + 40, 441), fill="#B98072", outline=HAIR, width=3)
            cutx = x + mirror * 35
            draw.ellipse((cutx - 29, 361, cutx + 29, 415), fill=PALE_TEAL)
            draw.line([(x + mirror * 12, 388), (x + mirror * 20, 417), (x + mirror * 16, 476)], fill=TEAL, width=5)
        centered(draw, (255, 491), "Kidneys · schematic", 18, PAPER_INK)
        for idx, label in enumerate(bullets or ["Renal function", "Risk–benefit assessment", "Local contrast guidance"]):
            card(draw, (462, 292 + idx * 80, 922, 362 + idx * 80), label, title_size=21)
    elif kind == "quiz":
        question = str(scene.get("question", subtitle or "Which choice best answers the clinical question?"))
        textblock(draw, (78, 211), question, 854, 26, INK, True, 32, 3)
        options = scene.get("options") or bullets
        for idx, option in enumerate(options[:3]):
            if isinstance(option, dict):
                label = str(option.get("label", chr(65 + idx)))
                value = str(option.get("text", ""))
            else:
                label, value = chr(65 + idx), str(option)
            y = 333 + idx * 68
            rr(draw, (85, y, 922, y + 57), WHITE, 13, "#D4DEDA")
            rr(draw, (94, y + 9, 132, y + 47), TEAL, 9)
            centered(draw, (113, y + 12), label, 23, WHITE, True)
            textblock(draw, (151, y + 13), value, 743, 21, INK, max_lines=1)
    elif kind == "recap":
        textblock(draw, (78, 211), subtitle or "Choose an investigation that answers the question and helps the patient.", 850, 25, INK, True, 33, 2)
        for idx, label in enumerate(bullets or ["Ask a clear clinical question", "Review prior imaging and relevant risks", "Interpret systematically and collaborate"]):
            y = 301 + idx * 77
            rr(draw, (84, y, 922, y + 63), WHITE, 15, "#D4DEDA")
            draw.ellipse((100, y + 12, 138, y + 50), fill=TEAL)
            tick(draw, 117, y + 31, IVORY, 8, 3)
            textblock(draw, (161, y + 14), label, 735, 24, INK, True, max_lines=1)
    return image


def visual_motion(draw, scene, t, duration):
    kind = scene["type"]
    phase = t / max(duration, 1)
    index = int(t / 4) % 3
    if kind == "intro":
        for start, end in (((338, 391), (363, 391)), ((622, 391), (647, 391))):
            step_arrow(draw, start, end, t * .4)
    elif kind == "toolkit":
        idx = min(3, int(phase * 4))
        x = 85 + idx * 214
        rr(draw, (x - 3, 291, x + 195, 496), None, 18, TEAL, 4)
        tool_icon(draw, ("Radiograph", "Ultrasound", "CT", "MRI")[idx], x + 96, 364, True)
    elif kind == "choice":
        step_arrow(draw, (428, 390), (474, 390), t * .45)
        y = 289 + index * 83
        rr(draw, (496, y, 922, y + 72), None, 16, TEAL, 3)
    elif kind == "case":
        pulse = (t * .55) % 1
        for idx in range(3):
            radius = 22 + idx * 18 + pulse * 18
            draw.arc((334 - radius, 422 - radius, 334 + radius, 422 + radius), 140, 216, fill=TEAL, width=2)
        y = 295 + index * 80
        rr(draw, (486, y, 920, y + 70), None, 16, TEAL, 3)
    elif kind == "prior":
        step_arrow(draw, (394, 381), (484, 381), t * .28)
    elif kind in ("request", "contrast", "kidney", "interpret"):
        box = {
            "request": (514, 292, 922, 69, 79), "contrast": (454, 291, 921, 71, 80),
            "kidney": (462, 292, 922, 70, 80), "interpret": (494, 292, 922, 70, 80),
        }[kind]
        x, y, right, h, step = box
        y += index * step
        rr(draw, (x, y, right, y + h), None, 16, TEAL, 3)
        if kind == "contrast":
            step_arrow(draw, (260, 410), (260, 449), t * .4, TEAL, 4)
        if kind == "interpret":
            if index == 0:
                draw.line((239, 337, 234, 478), fill=TEAL, width=4)
            elif index == 1:
                draw.ellipse((214, 304, 263, 347), outline=TEAL, width=4)
                draw.ellipse((213, 468, 255, 509), outline=TEAL, width=4)
            else:
                draw.rounded_rectangle((184, 302, 340, 507), radius=30, outline=TEAL, width=3)
    elif kind == "checklist":
        idx = min(5, int(phase * 6))
        x, y = 84 + (idx % 3) * 286, 289 + (idx // 3) * 121
        rr(draw, (x, y, x + 266, y + 102), None, 16, TEAL, 4)
        tick(draw, x + 42, y + 50, TEAL, 10, 4)
    elif kind == "quiz":
        # Do not invent a correct answer. Show a reveal only if the storyboard supplies it.
        answer = scene.get("answer")
        reveal = float(scene.get("reveal_after", .68))
        if answer is not None and phase > reveal:
            if isinstance(answer, int):
                idx = answer
            else:
                val = str(answer).strip().upper()
                idx = ord(val[0]) - 65 if val and val[0] in "ABC" else -1
            if 0 <= idx <= 2:
                y = 333 + idx * 68
                rr(draw, (85, y, 922, y + 57), None, 13, TEAL, 4)
                tick(draw, 898, y + 28, TEAL, 10, 3)
    elif kind == "recap":
        idx = min(2, int(phase * 3))
        y = 301 + idx * 77
        rr(draw, (84, y, 922, y + 63), None, 15, TEAL, 4)


def athena(draw, t, energy, speaking=True):
    """A single original Athena design, shared without generative drift across scenes."""
    breathe = math.sin(t * 2.2) * 1.5
    cx, cy = 1110, 277 + breathe
    # Warm, distinctive auburn bun and side-part hairstyle.
    draw.ellipse((cx + 17, cy - 81, cx + 70, cy - 32), fill=HAIR)
    draw.ellipse((cx - 51, cy - 66, cx + 51, cy + 52), fill=HAIR)
    draw.ellipse((cx - 52, cy + 8, cx - 34, cy + 32), fill=SKIN)
    draw.ellipse((cx + 35, cy + 8, cx + 53, cy + 32), fill=SKIN)
    rr(draw, (cx - 14, cy + 38, cx + 15, cy + 80), SKIN, 8)
    # Teal shirt and ivory coat: consistent silhouette, no unrelated clinical props.
    draw.polygon([(cx - 59, cy + 68), (cx + 59, cy + 68), (cx + 71, cy + 242), (cx - 73, cy + 242)], fill=IVORY)
    draw.polygon([(cx - 20, cy + 69), (cx + 21, cy + 69), (cx + 36, cy + 240), (cx - 37, cy + 240)], fill=TEAL)
    draw.polygon([(cx - 15, cy + 66), (cx - 42, cy + 87), (cx - 18, cy + 112), (cx - 2, cy + 83)], fill=WHITE)
    draw.polygon([(cx + 15, cy + 66), (cx + 43, cy + 87), (cx + 18, cy + 112), (cx + 2, cy + 83)], fill=WHITE)
    draw.line((cx, cy + 112, cx, cy + 238), fill="#0E626A", width=2)
    for dy in (133, 158, 183):
        draw.ellipse((cx + 6, cy + dy, cx + 10, cy + dy + 4), fill=GOLD)
    # Right arm and hand resting comfortably.
    draw.line([(cx + 57, cy + 83), (cx + 81, cy + 144), (cx + 48, cy + 172)], fill=IVORY, width=29)
    draw.line([(cx + 77, cy + 145), (cx + 49, cy + 170)], fill=SKIN, width=17)
    draw.ellipse((cx + 37, cy + 160, cx + 61, cy + 181), fill=SKIN)
    # Left arm points toward the learning panel, with a gentle pedagogical gesture.
    gesture = math.sin(t * 1.35) * 6
    elbow = (cx - 80, cy + 126)
    hand = (cx - 128, cy + 90 + gesture)
    draw.line([(cx - 54, cy + 81), elbow], fill=IVORY, width=29)
    draw.line([elbow, hand], fill=SKIN, width=17)
    draw.ellipse((hand[0] - 12, hand[1] - 8, hand[0] + 12, hand[1] + 10), fill=SKIN)
    draw.line([(hand[0], hand[1] - 2), (hand[0] - 22, hand[1] - 11)], fill=SKIN, width=7)
    rr(draw, (cx + 27, cy + 104, cx + 60, cy + 148), WHITE, 4, "#BDCCC4", 1)
    draw.ellipse((cx + 33, cy + 109, cx + 54, cy + 130), fill=TEAL)
    centered(draw, (cx + 43, cy + 108), "A", 15, WHITE, True)
    centered(draw, (cx + 43, cy + 132), "ATHENA", 5, INK, True)
    # Face, swept fringe, and stable glasses.
    draw.ellipse((cx - 42, cy - 50, cx + 42, cy + 52), fill=SKIN)
    draw.polygon([(cx - 43, cy - 18), (cx - 44, cy - 44), (cx - 18, cy - 59), (cx + 25, cy - 54), (cx + 42, cy - 29), (cx + 15, cy - 38), (cx - 8, cy - 27)], fill=HAIR)
    draw.ellipse((cx - 29, cy + 19, cx - 12, cy + 28), fill="#D29176")
    draw.ellipse((cx + 14, cy + 19, cx + 29, cy + 28), fill="#D29176")
    draw.arc((cx - 30, cy - 8, cx - 8, cy + 6), 195, 340, fill=HAIR, width=2)
    draw.arc((cx + 9, cy - 8, cx + 31, cy + 6), 195, 340, fill=HAIR, width=2)
    blink = (t + .8) % 5.7 < .16
    for ex in (cx - 19, cx + 19):
        if blink:
            draw.line((ex - 6, cy + 10, ex + 6, cy + 10), fill=INK, width=3)
        else:
            draw.ellipse((ex - 5, cy + 3, ex + 5, cy + 16), fill=WHITE)
            draw.ellipse((ex - 3, cy + 5, ex + 3, cy + 14), fill=INK)
            draw.ellipse((ex - 2, cy + 5, ex, cy + 7), fill=WHITE)
    for ex in (cx - 19, cx + 19):
        rr(draw, (ex - 15, cy - 1, ex + 15, cy + 22), None, 8, INK, 3)
    draw.line((cx - 4, cy + 7, cx + 4, cy + 7), fill=INK, width=3)
    draw.line((cx - 34, cy + 6, cx - 42, cy + 3), fill=INK, width=2)
    draw.line((cx + 34, cy + 6, cx + 42, cy + 3), fill=INK, width=2)
    draw.line([(cx + 1, cy + 14), (cx - 1, cy + 25), (cx + 5, cy + 25)], fill="#AD725C", width=2)
    opening = min(12, 2 + energy * 11) if speaking and energy > .07 else 0
    if opening:
        draw.ellipse((cx - 11, cy + 31, cx + 11, cy + 35 + opening), fill="#623735")
        draw.arc((cx - 10, cy + 30, cx + 10, cy + 39 + opening), 0, 180, fill="#B76C6F", width=3)
        draw.line((cx - 7, cy + 34, cx + 7, cy + 34), fill=IVORY, width=2)
    else:
        draw.arc((cx - 11, cy + 28, cx + 11, cy + 39), 5, 175, fill="#7A3F3B", width=3)


def parse_time(value):
    hours, mins, rest = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(mins) * 60 + float(rest)


def parse_srt(path):
    cues = []
    for block in re.split(r"\n\s*\n", path.read_text(encoding="utf-8-sig").strip()):
        lines = block.splitlines()
        timing_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if timing_index is None:
            continue
        left, right = lines[timing_index].split("-->", 1)
        cues.append((parse_time(left.strip()), parse_time(right.strip().split()[0]), " ".join(lines[timing_index + 1:])))
    return cues


def approximate_cues(narration, duration, offset=0):
    words = narration.split()
    if not words:
        return []
    phrases = []
    group = []
    for word in words:
        group.append(word)
        if len(group) >= 10 or (len(group) >= 4 and re.search(r"[.!?;:]$", word)):
            phrases.append(group)
            group = []
    if group:
        phrases.append(group)
    available = max(.1, duration - .12)
    cues, cursor = [], offset
    for phrase in phrases:
        end = cursor + available * len(phrase) / len(words)
        cues.append((cursor, end, " ".join(phrase)))
        cursor = end
    return cues


def srt_time(seconds):
    ms = round(seconds * 1000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(cues, path):
    text = "\n\n".join(f"{idx}\n{srt_time(start)} --> {srt_time(end)}\n{value}" for idx, (start, end, value) in enumerate(cues, 1)) + "\n"
    path.write_text(text, encoding="utf-8")


def audio_info(path):
    with wave.open(str(path), "rb") as wav:
        rate, count = wav.getframerate(), wav.getnframes()
        channels, width = wav.getnchannels(), wav.getsampwidth()
        if width not in (1, 2, 4):
            raise ValueError(f"{path}: use PCM WAV with 8, 16, or 32-bit samples.")
        raw = wav.readframes(count)
    if width == 1:
        values = array.array("B", raw)
    else:
        values = array.array("h" if width == 2 else "i", raw)
        if sys.byteorder != "little":
            values.byteswap()
    stride = max(1, int(rate * .04)) * channels
    energies = []
    for i in range(0, len(values), stride):
        segment = values[i:i + stride]
        if not segment:
            continue
        if width == 1:
            segment = [v - 128 for v in segment]
        # Sample every few values: adequate for mouth animation, bounded CPU.
        sample = segment[::max(1, len(segment) // 180)]
        energies.append(math.sqrt(sum(v * v for v in sample) / len(sample)))
    scale = sorted(energies)[int((len(energies) - 1) * .90)] if energies else 1
    energies = [min(1.0, e / max(1.0, scale)) for e in energies]
    return count / rate, energies


def find_caption(cues, t):
    for start, end, value in cues:
        if start <= t < end:
            return value
    return ""


def frame(base, visual, scene, index, total, t, duration, audio_duration, energies, cues, global_offset):
    image = base.copy()
    image.alpha_composite(visual)
    draw = ImageDraw.Draw(image)
    visual_motion(draw, scene, t, duration)
    energy = energies[min(len(energies) - 1, int(t / .04))] if energies and t < audio_duration else 0
    athena(draw, t + global_offset, energy, t < audio_duration)
    # Caption plate has a fixed two-line safe area, readable on a phone in landscape.
    rr(draw, (48, 601, 1232, 675), "#061820", 16, "#42616A", 1)
    caption = find_caption(cues, t + global_offset)
    if caption:
        lines = wrap(draw, caption, 1118, 25)
        if len(lines) > 2:
            lines = wrap(draw, caption, 1118, 22)
            size = 22
        else:
            size = 25
        y = 612 if len(lines) > 1 else 622
        for line in lines[:2]:
            centered(draw, (WIDTH / 2, y), line, size, IVORY)
            y += 29
    progress = max(0, min(1, t / duration))
    draw.line((49, 585, 49 + 908 * progress, 585), fill=GOLD, width=3)
    if scene["type"] == "recap" and t > duration - 3:
        rr(draw, (82, 533, 922, 555), "#E9E0C6", 7)
        centered(draw, (502, 535), "EDUCATIONAL DRAFT · MEDICAL REVIEW REQUIRED BEFORE PUBLICATION", 11, INK, True)
    return image.convert("RGB")


def run_checked(command, **kwargs):
    result = subprocess.run(command, capture_output=True, text=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {command[0]}\n{result.stderr[-5000:]}")
    return result


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def input_fingerprint(scene, audio, duration, global_offset, cues, args):
    # Increment template_version for visual changes. Encoding transport and
    # thread count do not change source frames or the content of the lesson.
    record = {
        "template_version": 1, "scene": scene, "audio_sha256": file_hash(audio),
        "duration": float(duration), "global_offset": float(global_offset),
        "captions": [cue for cue in cues if global_offset <= cue[0] < global_offset + duration],
        "width": WIDTH, "height": HEIGHT, "fps": FPS,
        "crf": args.crf, "preset": args.preset,
    }
    return hashlib.sha256(json.dumps(record, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def scene_metadata(scene, idx, global_offset, duration, audio_duration, project):
    return {"id": scene.get("id", idx), "type": scene["type"], "title": scene["title"], "start": global_offset, "duration": duration, "audio_duration": audio_duration, "reveal_after": scene.get("reveal_after"), "probe": str(project / f"probe-scene-{idx:02d}.png")}


def validate_storyboard(data):
    if not isinstance(data, dict) or not isinstance(data.get("scenes"), list) or not data["scenes"]:
        raise ValueError("storyboard.json must contain a nonempty scenes array.")
    for idx, scene in enumerate(data["scenes"], 1):
        if scene.get("type") not in KINDS:
            raise ValueError(f"Scene {idx}: unsupported type {scene.get('type')!r}.")
        if not isinstance(scene.get("narration"), str) or not scene["narration"].strip():
            raise ValueError(f"Scene {idx}: narration must be a nonempty string.")
        if not isinstance(scene.get("title"), str):
            raise ValueError(f"Scene {idx}: title is required.")
        if len(scene.get("bullets", [])) > 3:
            raise ValueError(f"Scene {idx}: at most three concise bullets are supported.")
    return data


def render(args):
    project = Path(args.project).resolve()
    storyboard_path = Path(args.storyboard).resolve() if args.storyboard else project / "storyboard.json"
    data = validate_storyboard(json.loads(storyboard_path.read_text(encoding="utf-8-sig")))
    ffmpeg = str(Path(args.ffmpeg).resolve()) if args.ffmpeg else shutil.which("ffmpeg")
    if not ffmpeg or not Path(ffmpeg).exists():
        raise RuntimeError("Supply --ffmpeg with an available ffmpeg executable.")
    output = Path(args.output).resolve() if args.output else project / "athena-diagnostic-imaging-draft.mp4"
    if output.suffix.lower() != ".mp4":
        raise ValueError("Output must be an .mp4 file.")
    if "draft" not in output.stem.lower():
        raise ValueError("Include 'draft' in the filename until medical and editorial review is complete.")
    output.parent.mkdir(parents=True, exist_ok=True)
    work = project / ".render-cache"
    work.mkdir(parents=True, exist_ok=True)
    scenes = data["scenes"]
    prepared = []
    offset = 0.0
    generated_cues = []
    for idx, scene in enumerate(scenes, 1):
        audio = project / "audio" / f"scene-{idx:02d}.wav"
        if not audio.exists():
            raise FileNotFoundError(audio)
        audio_duration, energies = audio_info(audio)
        # Frame boundaries are also scene boundaries, so SRT and concatenation agree.
        frames = math.ceil((audio_duration + args.padding) * FPS)
        duration = frames / FPS
        prepared.append((scene, audio, audio_duration, duration, frames, energies, offset))
        generated_cues.extend(approximate_cues(scene["narration"], audio_duration, offset))
        offset += duration
    supplied_srt = project / "captions.srt"
    if supplied_srt.exists() and not args.approximate_captions:
        cues = parse_srt(supplied_srt)
        if not cues:
            raise ValueError("captions.srt contains no readable cues.")
        cue_source = "provided captions.srt"
    else:
        cues = generated_cues
        write_srt(cues, project / "captions-approximate.srt")
        cue_source = "approximate word-proportional cues (not forced alignment)"
    screenshots = []
    metadata_scenes = []
    clips = []
    total = len(prepared)
    print(f"Rendering {total} scenes, {offset:.1f}s, {WIDTH}x{HEIGHT} at {FPS}fps. Captions: {cue_source}", flush=True)
    for idx, (scene, audio, audio_duration, duration, frames, energies, global_offset) in enumerate(prepared, 1):
        if scene["type"] == "quiz" and "reveal_after" not in scene:
            # Approximate captions are our narration clock; match the reveal to
            # the answer cue rather than assume a fixed fraction of the scene.
            answer_cue = next((start for start, end, value in cues if global_offset <= start < global_offset + audio_duration and re.search(r"correct answer is", value, re.I)), None)
            if answer_cue is not None:
                scene = {**scene, "reveal_after": (answer_cue - global_offset) / duration}
        print(f"Scene {idx:02d}/{total:02d}: {scene['title']} ({duration:.1f}s)", flush=True)
        base = BACKGROUND.copy().convert("RGBA")
        header(ImageDraw.Draw(base), scene, idx, total)
        visual = visual_base(scene)
        clip = work / f"scene-{idx:02d}.mp4"
        clips.append(clip)
        fingerprint = input_fingerprint(scene, audio, duration, global_offset, cues, args)
        manifest_path = work / f"scene-{idx:02d}.json"
        if args.resume and clip.exists() and manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            probe = project / f"probe-scene-{idx:02d}.png"
            if manifest.get("input_fingerprint") == fingerprint and manifest.get("output_sha256") == file_hash(clip) and probe.exists():
                print(f"  Reused scene {idx:02d}; input fingerprint and output checksum verified.", flush=True)
                screenshots.append(probe)
                metadata_scenes.append(scene_metadata(scene, idx, global_offset, duration, audio_duration, project))
                continue
        video_clip = work / f"scene-{idx:02d}.video.mp4"
        stream_input = (["-f", "image2pipe", "-vcodec", "png", "-framerate", str(FPS)] if args.transport == "png" else ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS)])
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-probesize", "32", "-analyzeduration", "0", *stream_input, "-i", "pipe:0", "-an",
            "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
            "-threads", str(args.threads), "-pix_fmt", "yuv420p", "-frames:v", str(frames),
            "-movflags", "+faststart", str(video_clip),
        ]
        error_file = work / f"scene-{idx:02d}.log"
        with error_file.open("wb") as error_out:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=error_out)
            try:
                for frame_idx in range(frames):
                    t = frame_idx / FPS
                    result = frame(base, visual, scene, idx, total, t, duration, audio_duration, energies, cues, global_offset)
                    if args.transport == "png":
                        # Lossless PNG substantially lowers pipe traffic on
                        # Windows while preserving text and diagrams exactly.
                        buffer = io.BytesIO()
                        result.save(buffer, format="PNG", compress_level=1)
                        process.stdin.write(buffer.getvalue())
                    else:
                        process.stdin.write(result.tobytes())
                    if frame_idx == min(frames - 1, int(duration * .45 * FPS)):
                        screenshot = project / f"probe-scene-{idx:02d}.png"
                        result.save(screenshot)
                        screenshots.append(screenshot)
                        if idx == 1:
                            result.save(project / "poster.png")
                process.stdin.close()
                code = process.wait()
                if code:
                    raise RuntimeError(f"ffmpeg scene {idx} failed: {error_file.read_text(errors='replace')[-5000:]}")
            except Exception:
                if process.stdin and not process.stdin.closed:
                    try:
                        process.stdin.close()
                    except BrokenPipeError:
                        pass
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)
                raise
        # File-to-file audio muxing prevents a second input plus infinite audio
        # padding from back-pressuring the streamed video input on Windows.
        run_checked([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video_clip), "-i", str(audio),
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
            "-ar", "48000", "-ac", "2", "-af", "apad", "-t", f"{duration:.6f}", "-movflags", "+faststart", str(clip),
        ])
        video_clip.unlink(missing_ok=True)
        manifest_path.write_text(json.dumps({"input_fingerprint": fingerprint, "output_sha256": file_hash(clip)}, indent=2) + "\n", encoding="utf-8")
        metadata_scenes.append(scene_metadata(scene, idx, global_offset, duration, audio_duration, project))
    concat_file = work / "concat.txt"
    concat_file.write_text("\n".join("file '" + str(clip).replace("\\", "/").replace("'", "'\\''") + "'" for clip in clips) + "\n", encoding="utf-8")
    print("Joining final MP4 and embedding optional captions…", flush=True)
    # Burned-in captions remain visible in every player; the soft-caption track can
    # also be selected independently by compatible players.
    final_srt = work / "captions-final.srt"
    write_srt(cues, final_srt)
    run_checked([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-i", str(final_srt), "-map", "0:v:0", "-map", "0:a:0", "-map", "1:0",
        "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
        "-metadata", f"title={data.get('title', 'Athena: Diagnostic imaging')}",
        "-metadata", "comment=Educational draft. Medical review pending. Approximate caption timing unless separately aligned.",
        "-movflags", "+faststart", str(output),
    ])
    cols = min(3, total)
    rows = math.ceil(total / cols)
    thumb_w, thumb_h = 426, 240
    contact = Image.new("RGB", (cols * thumb_w, rows * (thumb_h + 40)), DARK)
    contact_draw = ImageDraw.Draw(contact)
    for idx, path in enumerate(screenshots):
        x, y = idx % cols * thumb_w, idx // cols * (thumb_h + 40)
        with Image.open(path) as image:
            contact.paste(image.resize((thumb_w, thumb_h), Image.Resampling.LANCZOS), (x, y))
        textblock(contact_draw, (x + 10, y + thumb_h + 7), f"{idx + 1:02d}  {scenes[idx]['title']}", thumb_w - 20, 16, IVORY, max_lines=1)
    contact.save(project / "contact-sheet.png")
    metadata = {
        "title": data.get("title"), "status": "educational draft; review pending",
        "output": str(output), "width": WIDTH, "height": HEIGHT, "fps": FPS,
        "duration": offset, "caption_source": cue_source, "scene_padding": args.padding,
        "character": "Original code-drawn Athena, fixed auburn bun, glasses, teal outfit, ivory coat.",
        "scenes": metadata_scenes,
    }
    (project / "video-metadata.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Finished: {output} ({output.stat().st_size / 1048576:.1f} MiB)", flush=True)
    print(f"Visual QA: {project / 'contact-sheet.png'}", flush=True)
    if not args.keep_clips:
        for clip in clips:
            clip.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="Folder containing storyboard.json, audio/scene-01.wav, etc.")
    parser.add_argument("--storyboard", help="Alternate storyboard JSON path.")
    parser.add_argument("--ffmpeg", help="Path to ffmpeg executable (or use PATH).")
    parser.add_argument("--output", help="MP4 output path; filename must contain 'draft'.")
    parser.add_argument("--padding", type=float, default=.5, help="Scene silence padding, default .5 seconds.")
    parser.add_argument("--crf", type=int, default=21, help="H.264 quality factor, default 21.")
    parser.add_argument("--preset", default="veryfast", help="ffmpeg libx264 encoding preset.")
    parser.add_argument("--transport", choices=("png", "raw"), default="png", help="Lossless PNG pipe (default) or uncompressed RGB pipe.")
    parser.add_argument("--threads", type=int, default=4, help="H264 encoder threads, default four.")
    parser.add_argument("--resume", action="store_true", help="Reuse cached scene clips only when input fingerprint and output checksum match.")
    parser.add_argument("--approximate-captions", action="store_true", help="Generate approximate cues instead of reading captions.srt.")
    parser.add_argument("--keep-clips", action="store_true", help="Retain per-scene MP4 render cache.")
    args = parser.parse_args()
    if args.padding < 0 or args.padding > 5:
        parser.error("Padding must be between 0 and 5 seconds.")
    if not 0 <= args.crf <= 51:
        parser.error("CRF must be between 0 and 51.")
    render(args)


if __name__ == "__main__":
    main()
