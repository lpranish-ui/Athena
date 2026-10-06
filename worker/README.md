# Optional PDF/OCR tools

Athena's Node API processes uploads through its Postgres queue. There is no
Supabase dependency, storage bucket or second credentials-based worker.

The API uses `pdftotext` for searchable PDFs and falls back to pdf.js in local
development. For scans it attempts `ocrmypdf` when installed on the API host,
then extracts the searchable result through the same ingestion pipeline.
Missing OCR tools produce a readable upload error. OCR is limited to ten
minutes per file. Set `OCR_LANG` on the API host for another installed language
(default `eng`). The default API Docker image includes Poppler; OCR installation
is optional and requires OCRmyPDF, Tesseract and Ghostscript.

This directory also provides a local diagnostic CLI that writes chapter JSON:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python worker.py input.pdf --output chapters.json
python worker.py scanned.pdf --ocr --output chapters.json
```

Install [OCRmyPDF's system dependencies](https://ocrmypdf.readthedocs.io/en/latest/installation.html)
before using `--ocr`. For searchable PDFs, only `pypdfium2` is required:
`pip install pypdfium2`. No API keys or database credentials are used. This CLI
does not import its JSON into the server; upload the original PDF through the
app to use the normal ownership, duplicate and retry checks.

Run the pure Python chapter regression tests with
`python -m unittest discover -s worker -p test_*.py`.
