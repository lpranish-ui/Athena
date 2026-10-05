"""Athena background worker.

Polls the `jobs` table (via the `claim_job()` Postgres function) and processes
heavy work outside the edge functions — today that means OCR for scanned PDFs.

Setup and run instructions: see worker/README.md
"""

from __future__ import annotations

import os
import time
import traceback
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import create_client

from ingest import DuplicateUpload, process_ingest_job

load_dotenv()

POLL_SECONDS = int(os.getenv("POLL_SECONDS", "5"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise SystemExit(
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in worker/.env first "
            "(see worker/README.md)."
        )

    client = create_client(url, key)
    print("Athena worker started — polling for jobs… (Ctrl+C to stop)")

    while True:
        try:
            response = client.rpc("claim_job").execute()
            job = (response.data or [None])[0]
            if not job:
                time.sleep(POLL_SECONDS)
                continue

            print(f"→ claimed job {job['id']} ({job['type']}, attempt {job['attempts']})")
            try:
                if job["type"] == "ingest_book":
                    outcome = process_ingest_job(client, job)
                else:
                    raise RuntimeError(f"Unsupported job type: {job['type']}")

                client.table("jobs").update(
                    {
                        "status": "done",
                        "result": outcome,
                        "error": None,
                        "finished_at": now_iso(),
                    }
                ).eq("id", job["id"]).execute()
                print(f"✓ job {job['id']} done: {outcome}")

            except DuplicateUpload as err:
                _finish_failed(client, job, str(err), retry=False)
                print(f"✗ job {job['id']} duplicate file: {err}")

            except Exception as err:  # noqa: BLE001 — report any processing failure
                traceback.print_exc()
                _finish_failed(client, job, str(err), retry=int(job.get("attempts") or 1) < 3)

        except Exception:  # noqa: BLE001 — network hiccups: log and keep polling
            traceback.print_exc()
            time.sleep(POLL_SECONDS)


def _finish_failed(client, job, message: str, retry: bool) -> None:
    update: dict = {
        "error": message[:500],
        "status": "queued" if retry else "error",
    }
    if retry:
        update["started_at"] = None
    else:
        update["finished_at"] = now_iso()
        book_id = (job.get("payload") or {}).get("bookId")
        if book_id:
            client.table("books").update(
                {"status": "error", "status_message": message[:500]}
            ).eq("id", book_id).execute()
    client.table("jobs").update(update).eq("id", job["id"]).execute()


if __name__ == "__main__":
    main()
