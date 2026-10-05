// End-to-end test of the file-upload pipeline against the live API:
// generates a small text-based PDF (3 chapters), uploads it exactly like the
// app does (raw bytes + headers), verifies the chapters were extracted, then
// cleans up.
//
// Usage: SMOKE_URL=https://athena-api-w018.onrender.com node scripts/test-upload.js

const base = process.env.SMOKE_URL ?? 'http://localhost:8787';

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

// ── minimal text-based PDF builder (one page per chapter) ───────────────────

function buildPdf(pageLines) {
  const count = pageLines.length;
  const objects = new Array(4 + 2 * count);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pageLines.map((_, index) => `${4 + index} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  pageLines.forEach((lines, index) => {
    const pageId = 4 + index;
    const contentId = 4 + count + index;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;

    let stream = '';
    let y = 720;
    for (const line of lines) {
      const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      stream += `BT /F1 12 Tf 72 ${y} Td (${escaped}) Tj ET\n`;
      y -= 16;
    }
    objects[contentId] = { stream };
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    const object = objects[id];
    if (object && object.stream !== undefined) {
      pdf += `${id} 0 obj\n<< /Length ${Buffer.byteLength(object.stream, 'latin1')} >>\nstream\n${object.stream}endstream\nendobj\n`;
    } else {
      pdf += `${id} 0 obj\n${object}\nendobj\n`;
    }
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function chapterPage(title, paragraphs) {
  const lines = [title];
  for (const paragraph of paragraphs) {
    // wrap to ~70-char lines so pdfjs emits readable text
    let remaining = paragraph;
    while (remaining.length > 0) {
      lines.push(remaining.slice(0, 70));
      remaining = remaining.slice(70);
    }
  }
  return lines;
}

// ── the test ─────────────────────────────────────────────────────────────────

console.log(`\nUpload pipeline test against ${base}\n`);

const auth = await call('POST', '/api/auth/signin', {
  body: { email: 'group-test@athena.dev', password: 'password123' },
});
if (auth.status !== 200) {
  console.error('sign-in failed', auth.status, auth.data);
  process.exit(1);
}
const token = auth.data.token;

const pdf = buildPdf([
  chapterPage('Chapter 1 The Cell', [
    'The cell is the basic structural and functional unit of all living organisms on Earth. It is bounded by a plasma membrane that separates the interior from the surrounding environment and carefully controls which substances enter and leave.',
    'Inside the cytoplasm, organelles such as mitochondria produce ATP through oxidative phosphorylation, while the endoplasmic reticulum folds and transports proteins destined for secretion from the cell.',
  ]),
  chapterPage('Chapter 2 Tissues', [
    'A tissue is a group of similar cells that work together to perform a shared function within the body of a multicellular organism. Epithelial tissue covers surfaces and lines cavities throughout the body.',
    'Connective tissue, including bone, cartilage, fat and blood, supports and binds other structures while transporting nutrients between distant sites in the organism.',
  ]),
  chapterPage('Chapter 3 Organs', [
    'An organ is a collection of tissues joined in a structural unit to serve a common function. The heart, for example, combines muscle, connective, nervous and epithelial tissues to pump blood.',
    'Organ systems group organs that cooperate toward one goal, such as the cardiovascular system delivering oxygen and nutrients to every cell of the body.',
  ]),
]);
console.log(`generated test PDF: ${pdf.length} bytes`);

const created = await call('POST', '/api/books', {
  token,
  body: { title: 'Upload Pipeline Test', file_type: 'pdf', subject: 'Histology' },
});
if (created.status !== 201) {
  console.error('create book failed', created.status, created.data);
  process.exit(1);
}
const bookId = created.data.id;
console.log(`created shell book ${bookId} (status=${created.data.status})`);

const uploadResponse = await fetch(`${base}/api/upload/${bookId}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/octet-stream',
    'x-file-type': 'pdf',
  },
  body: pdf,
  signal: AbortSignal.timeout(180000),
});
const uploadBody = await uploadResponse.json().catch(() => null);
console.log(`upload response: ${uploadResponse.status} ${JSON.stringify(uploadBody)}`);

let passed = uploadResponse.status === 200 && (uploadBody?.chapters ?? 0) >= 2;

if (passed) {
  const book = await call('GET', `/api/books/${bookId}`, { token });
  const chapterList = await call('GET', `/api/books/${bookId}/chapters`, { token });
  console.log(`book status: ${book.data?.status}, chapters: ${chapterList.data?.length}`);
  for (const chapter of chapterList.data ?? []) {
    console.log(`  ${chapter.number}. ${chapter.title} (pages ${chapter.first_page}-${chapter.last_page})`);
  }
  passed = book.data?.status === 'ready' && (chapterList.data?.length ?? 0) >= 2;
}

const cleanup = await call('DELETE', `/api/books/${bookId}`, { token });
console.log(`cleanup: ${cleanup.status}`);

console.log(passed ? '\nUPLOAD PIPELINE OK\n' : '\nUPLOAD PIPELINE FAILED\n');
process.exitCode = passed ? 0 : 1;
