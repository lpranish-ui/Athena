# Athena worker (OCR + heavy ingestion)

The app runs on Supabase edge functions, which are perfect for quizzes but
cannot run OCR. This small Python worker handles **scanned PDFs**:

1. When a student uploads a PDF that has no selectable text, the `ingest-book`
   edge function saves the book with status **queued** and inserts a row into
   the `jobs` table.
2. This worker claims the job (`claim_job()` in Postgres, safe for multiple
   workers), downloads the PDF, runs **OCRmyPDF + Tesseract** to add a text
   layer, extracts text page by page with **pypdfium2**, splits the book into
   chapters (same pipeline as the edge function) and stores everything.
3. The book flips to **ready** (or **error** with a readable message).

Failed jobs retry up to 3 times, then stop with the error visible in the app.

## 1. Install system tools

OCRmyPDF needs **Tesseract** and **Ghostscript** installed on the machine.

- **Windows**: install [Tesseract (UB Mannheim build)](https://github.com/UB-Mannheim/tesseract/wiki)
  and [Ghostscript](https://www.ghostscript.com/releases/gsdnld.html), then make
  sure both are on your PATH.
- **macOS**: `brew install tesseract ghostscript`
- **Linux**: `sudo apt install tesseract-ocr ghostscript`

## 2. Set up the worker

```bash
cd worker
python -m venv .venv
.venv\Scripts\activate        # Windows (PowerShell)
# source .venv/bin/activate   # macOS / Linux
pip install -r requirements.txt
```

Create `worker/.env` (never commit it — it contains the service-role key):

```
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
# optional
OCR_LANG=eng
POLL_SECONDS=5
```

> The **service-role key** is on the Supabase dashboard under
> Project Settings → API. It bypasses security rules, so keep it only on the
> worker machine. Never put it in the app's `.env`.

Also make sure migration `0003_jobs_and_multi_chapter.sql` has been run — it
creates the `jobs` table and the `claim_job()` function.

## 3. Run

```bash
python worker.py
```

Leave it running while students upload scans. You should see one line per
claimed job.

## Deploying it (optional, for production)

Any small always-on machine works: a $5–20/month VM (Hetzner, DigitalOcean),
Render/Fly.io background worker, or even a home PC while testing. Run it with a
process manager (systemd, NSSM on Windows, Docker) so it restarts on failures.

## How jobs flow

```
app uploads PDF ──► ingest-book (edge) ──► no text layer?
                                            │ yes
                                            ▼
                              books.status = 'queued'
                              jobs row (type 'ingest_book')
                                            │
                        worker claims job ──┘
                          download → OCR → extract → chapters → ready
```
