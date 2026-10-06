"""Local PDF/OCR diagnostic tool for Athena's Node/Postgres backend.

Production upload jobs run in the API's durable Postgres queue. This utility
extracts a local PDF without credentials or writes to a remote database.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ingest import process_pdf


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract a local PDF into chapter JSON.")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--ocr", action="store_true", help="Use optional OCRmyPDF for scanned pages.")
    parser.add_argument("--output", type=Path, help="Write JSON here instead of stdout.")
    args = parser.parse_args()
    if not args.pdf.is_file():
        parser.error(f"PDF not found: {args.pdf}")
    try:
        result = process_pdf(str(args.pdf.resolve()), run_ocr=args.ocr)
    except Exception as error:
        parser.exit(1, f"Could not extract PDF: {error}\n")
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text)


if __name__ == "__main__":
    main()
