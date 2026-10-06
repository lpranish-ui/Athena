"""Local PDF extraction and chapter diagnostics for Athena.

Uses the same chapter/page-map conventions as the Node API. OCR is optional;
database job processing and ownership checks belong to the API.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile

MAX_TOTAL_CHARS = 6_000_000
MIN_TEXT_LENGTH = 100
MAX_CHAPTERS = 120
FALLBACK_CHARS_PER_PART = 9000
SCAN_TEXT_THRESHOLD = MIN_TEXT_LENGTH

HEADING_RE = re.compile(
    r"^[ \t]*(?:chapter|unit|section|part)\s+([0-9]{1,3}|[ivxlcdm]{1,7})\b[\s:.\-–—]*(.{0,80})$",
    re.IGNORECASE,
)


# ── job entry point ──────────────────────────────────────────────────────────

def process_pdf(pdf_path: str, *, run_ocr: bool = False) -> dict:
    """Extract locally; the API owns upload persistence and job retries."""
    with tempfile.TemporaryDirectory() as tmp:
        lines = _extract_lines(pdf_path)
        text_length = sum(len(line["text"]) for line in lines)

        if text_length < SCAN_TEXT_THRESHOLD:
            if not run_ocr:
                raise RuntimeError("This PDF needs OCR. Install OCRmyPDF/Tesseract and pass --ocr.")
            ocr_path = os.path.join(tmp, "ocr.pdf")
            _run_ocr(pdf_path, ocr_path)
            lines = _extract_lines(ocr_path)

    if not lines:
        raise RuntimeError("No readable text was found in this PDF, even after OCR.")

    total_chars = sum(len(line["text"]) + 1 for line in lines)
    if total_chars > MAX_TOTAL_CHARS:
        raise RuntimeError("Extracted text exceeds the limit; split the PDF into smaller volumes.")

    chapters = _split_into_chapters(lines)
    if not chapters:
        raise RuntimeError("No chapters could be built from this PDF.")

    return {"chapters": chapters}


# ── PDF text extraction ──────────────────────────────────────────────────────

def _extract_lines(pdf_path: str) -> list[dict]:
    import pypdfium2 as pdfium  # optional; pure tests need no native tools
    pdf = pdfium.PdfDocument(pdf_path)
    lines: list[dict] = []
    try:
        for index in range(len(pdf)):
            page = pdf[index]
            textpage = page.get_textpage()
            text = textpage.get_text_range()
            textpage.close()
            page.close()
            for raw_line in text.split("\n"):
                stripped = raw_line.strip()
                if stripped:
                    lines.append({"text": stripped, "page": index + 1})
    finally:
        pdf.close()
    return lines


def _run_ocr(input_path: str, output_path: str) -> None:
    lang = os.getenv("OCR_LANG", "eng")
    try:
        subprocess.run(
            [
                "ocrmypdf",
                "--skip-text",
                "--optimize",
                "0",
                "--output-type",
                "pdf",
                "-l",
                lang,
                input_path,
                output_path,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=600,
        )
    except FileNotFoundError as err:
        raise RuntimeError(
            "OCRmyPDF is not installed. Install OCRmyPDF and Tesseract first "
            "(see worker/README.md)."
        ) from err
    except subprocess.CalledProcessError as err:
        detail = (err.stderr or err.stdout or "").strip().replace("\n", " ")[:300]
        raise RuntimeError(f"OCR failed: {detail}") from err
    except subprocess.TimeoutExpired as err:
        raise RuntimeError("OCR exceeded the ten-minute processing limit.") from err


# ── chapter splitting (port of the edge-function pipeline) ───────────────────

def _build_doc(lines: list[dict]) -> tuple[str, list[dict]]:
    content = ""
    page_map: list[dict] = []
    current_page = None
    for line in lines:
        if content:
            content += "\n"
        if line["page"] is not None and line["page"] != current_page:
            page_map.append({"page": line["page"], "char_start": len(content)})
            current_page = line["page"]
        content += line["text"]
    return content, page_map


def _pages_of(lines: list[dict]) -> tuple[int | None, int | None]:
    first = last = None
    for line in lines:
        if line["page"] is None:
            continue
        if first is None:
            first = line["page"]
        last = line["page"]
    return first, last


def _to_draft(title: str, lines: list[dict]) -> dict:
    content, page_map = _build_doc(lines)
    first, last = _pages_of(lines)
    return {
        "title": title,
        "content": content,
        "page_map": page_map,
        "first_page": first,
        "last_page": last,
    }


def _ceil_div(value: int, divisor: int) -> int:
    return -(-value // divisor)


def _chunk_fallback(lines: list[dict]) -> list[dict]:
    total = sum(len(line["text"]) + 1 for line in lines)
    target_parts = min(MAX_CHAPTERS, max(1, _ceil_div(total, FALLBACK_CHARS_PER_PART)))
    chunk_size = max(1, _ceil_div(total, target_parts))

    chunks: list[dict] = []
    current: list[dict] = []
    current_chars = 0
    for line in lines:
        current.append(line)
        current_chars += len(line["text"]) + 1
        if current_chars >= chunk_size:
            chunks.append(_to_draft(f"Part {len(chunks) + 1}", current))
            current, current_chars = [], 0
    if current:
        chunks.append(_to_draft(f"Part {len(chunks) + 1}", current))
    return chunks


def _normalize_lead(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()[:48].strip()


_TOC_LINE_RE = re.compile(r"^(.{3,90}?)[\s.·•…]{2,}(\d{1,4})\s*$")


def _toc_entries(lines: list[dict]) -> list[tuple[str, int]]:
    """Pulls "Title .... 123" style contents entries from the front matter."""
    entries: list[tuple[str, int]] = []
    seen: set[str] = set()
    for line in lines:
        page = line["page"]
        if page is None:
            continue
        if page > 40:
            break
        text = line["text"].strip()
        if len(text) < 4 or len(text) > 100:
            continue
        match = _TOC_LINE_RE.match(text)
        if not match:
            continue
        title = re.sub(r"[\s.·•…]+$", "", match.group(1)).strip()
        try:
            printed = int(match.group(2))
        except ValueError:
            continue
        if not re.search(r"[a-zA-Z]", title) or len(title) < 3:
            continue
        if printed < 1 or printed > 5000:
            continue
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        entries.append((title, printed))
    return entries


def _build_drafts_from_starts(lines: list[dict], starts: list[tuple[str, int]]):
    max_page = 0
    for line in lines:
        if line["page"] is not None and line["page"] > max_page:
            max_page = line["page"]
    if max_page == 0:
        return None

    drafts: list[dict] = []
    starts = starts[:MAX_CHAPTERS]
    for i, (title, page) in enumerate(starts):
        if i >= MAX_CHAPTERS:
            break
        start = 1 if i == 0 else page
        end = starts[i + 1][1] - 1 if i + 1 < len(starts) else max_page
        segment = [
            line for line in lines if line["page"] is not None and start <= line["page"] <= end
        ]
        if not segment:
            continue
        drafts.append(_to_draft(title or f"Chapter {i + 1}", segment))

    usable = [draft for draft in drafts if len(draft["content"]) >= MIN_TEXT_LENGTH]
    return drafts if len(usable) >= 2 else None


def _chapters_from_toc(lines: list[dict]) -> list[dict] | None:
    entries = _toc_entries(lines)
    if len(entries) < 4:
        return None

    matched: list[tuple[str, int, int]] = []
    for title, printed in entries:
        wanted = _normalize_lead(title)
        if len(wanted) < 6:
            continue
        for line in lines:
            if line["page"] is None or line["page"] <= 40:
                continue
            if _normalize_lead(line["text"]).startswith(wanted):
                matched.append((title, printed, line["page"]))
                break
    if len(matched) < 3:
        return None

    offset_counts: dict[int, int] = {}
    for _, printed, pdf_page in matched:
        offset = pdf_page - printed
        offset_counts[offset] = offset_counts.get(offset, 0) + 1
    best_offset, best_count = max(offset_counts.items(), key=lambda item: item[1])
    if best_count < max(2, len(matched) // 2):
        return None

    starts = sorted(
        ((title, printed + best_offset) for title, printed, _ in matched),
        key=lambda item: item[1],
    )
    starts = [(title, page) for title, page in starts if page >= 1]

    unique: list[tuple[str, int]] = []
    for title, page in starts:
        if unique and page <= unique[-1][1]:
            continue
        unique.append((title, page))
    if len(unique) < 3:
        return None

    return _build_drafts_from_starts(lines, unique)


def _split_into_chapters(lines: list[dict]) -> list[dict]:
    from_toc = _chapters_from_toc(lines)
    if from_toc:
        return from_toc

    candidates: list[tuple[int, str]] = []
    seen: set[str] = set()

    for index, line in enumerate(lines):
        text = line["text"].strip()
        if not text or len(text) > 90:
            continue
        if re.search(r"\.{2,}\s*\d+\s*$", text):
            continue  # table-of-contents dot leaders
        match = HEADING_RE.match(text)
        if not match:
            continue
        key = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
        if key in seen:
            continue  # running headers repeat on every page
        seen.add(key)
        candidates.append((index, re.sub(r"\s+", " ", text)))

    if 2 <= len(candidates) <= 60:
        segments: list[dict] = []
        for i, (line_index, title) in enumerate(candidates[:MAX_CHAPTERS]):
            start = 0 if i == 0 else line_index
            end = candidates[i + 1][0] if i + 1 < len(candidates) else len(lines)
            segments.append(_to_draft(title, lines[start:end]))

        merged: list[dict] = []
        for segment in segments:
            if merged and len(segment["content"]) < 300:
                previous = merged[-1]
                offset = len(previous["content"]) + 1
                previous["content"] += "\n" + segment["content"]
                previous["page_map"].extend(
                    {"page": mark["page"], "char_start": offset + mark["char_start"]}
                    for mark in segment["page_map"]
                )
                previous["last_page"] = segment["last_page"] or previous["last_page"]
            else:
                merged.append(segment)

        usable = [segment for segment in merged if len(segment["content"]) >= MIN_TEXT_LENGTH]
        if len(usable) >= 2:
            return [segment for segment in merged if segment["content"]]

    return _chunk_fallback(lines)
