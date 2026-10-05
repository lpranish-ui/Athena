// End-to-end smoke test for the Athena API.
//
// Usage: node scripts/smoke.js            (server must be running on :8787)
//        SMOKE_URL=http://... node scripts/smoke.js
//
// Exercises: health, auth (signup/signin), library, chapters, a REAL DeepSeek
// quiz generation, sets, text ingest (create -> verify -> delete), and
// account deletion. The test account is removed at the end.

const base = process.env.SMOKE_URL ?? 'http://localhost:8787';

const results = [];
let failed = 0;

function ok(name, detail) {
  results.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, message) {
  failed += 1;
  results.push(`  ✗ ${name} — ${message}`);
}

async function call(method, path, { token, body, headers = {}, timeoutMs = 30000 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
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

// ── 1. health ────────────────────────────────────────────────────────────────

console.log(`\nSmoke test against ${base}\n`);

try {
  const health = await call('GET', '/api/health');
  if (health.status === 200 && health.data?.ok) ok('health', 'database reachable');
  else fail('health', `status ${health.status}`);
} catch (error) {
  fail('health', error.message);
  console.log(results.join('\n'));
  process.exitCode = 1;
}

if (!token) {
  console.log(results.join('\n'));
  process.exitCode = 1;
  process.exit(1);
}

// ── 3. library + chapters ────────────────────────────────────────────────────

const email = 'smoke-test@athena.dev';
const password = 'password123';
let token = null;

try {
  let auth = await call('POST', '/api/auth/signup', {
    body: { email, password, full_name: 'Smoke Test' },
  });
  if (auth.status === 409) {
    auth = await call('POST', '/api/auth/signin', { body: { email, password } });
  }
  if (auth.status === 200 || auth.status === 201) {
    token = auth.data?.token;
    ok('auth', `signed in as ${auth.data?.user?.email}`);
  } else {
    fail('auth', `status ${auth.status}: ${JSON.stringify(auth.data)}`);
  }
} catch (error) {
  fail('auth', error.message);
}

if (!token) {
  console.log(results.join('\n'));
  process.exit(1);
}

// ── 3. library + chapters ────────────────────────────────────────────────────

let firstChapterId = null;
let firstBook = null;

try {
  const books = await call('GET', '/api/books', { token });
  if (books.status === 200 && Array.isArray(books.data)) {
    const withChapters = books.data.filter((book) => book.chapter_count > 0);
    firstBook = withChapters[0] ?? books.data[0] ?? null;
    ok(
      'library',
      `${books.data.length} books — ${books.data
        .slice(0, 3)
        .map((book) => `"${book.title}" (${book.chapter_count} ch)`)
        .join(', ')}`,
    );
  } else {
    fail('library', `status ${books.status}`);
  }
} catch (error) {
  fail('library', error.message);
}

try {
  if (!firstBook) throw new Error('no book to inspect');
  const chapters = await call('GET', `/api/books/${firstBook.id}/chapters`, { token });
  if (chapters.status === 200 && Array.isArray(chapters.data) && chapters.data.length > 0) {
    firstChapterId = chapters.data[0].id;
    ok('chapters', `${chapters.data.length} chapters, first: "${chapters.data[0].title}"`);
  } else {
    fail('chapters', `status ${chapters.status}`);
  }
} catch (error) {
  fail('chapters', error.message);
}

// ── 4. REAL quiz generation (DeepSeek) ───────────────────────────────────────

let generatedSetId = null;

try {
  if (!firstChapterId) throw new Error('no chapter available');
  const started = Date.now();
  const generated = await call('POST', '/api/ai/generate-mcqs', {
    token,
    timeoutMs: 180000,
    body: {
      chapterId: firstChapterId,
      count: 5,
      difficulty: 'easy',
      questionType: 'single_best_answer',
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (generated.status === 200 && generated.data?.setId) {
    generatedSetId = generated.data.setId;
    ok('AI quiz generation', `${generated.data.count} questions in ${seconds}s (set ${generated.data.setId.slice(0, 8)}…)`);
  } else {
    fail('AI quiz generation', `status ${generated.status}: ${JSON.stringify(generated.data)}`);
  }
} catch (error) {
  fail('AI quiz generation', error.message);
}

// ── 5. sets ──────────────────────────────────────────────────────────────────

try {
  if (generatedSetId) {
    const set = await call('GET', `/api/sets/${generatedSetId}`, { token });
    if (set.status === 200 && set.data?.mcqs?.length > 0) {
      const first = set.data.mcqs[0];
      ok(
        'set detail',
        `"${first.question.slice(0, 60)}…" — quote: ${first.supporting_quote ? 'yes' : 'NO'}, page: ${first.source_page ?? 'n/a'}`,
      );
    } else {
      fail('set detail', `status ${set.status}`);
    }
  } else {
    fail('set detail', 'no set generated');
  }
} catch (error) {
  fail('set detail', error.message);
}

// ── 6. text ingest (create -> verify -> delete) ──────────────────────────────

try {
  const chapterA =
    'Chapter 1: The Cell. The cell is the basic structural and functional unit of every living organism on Earth. ' +
    'It is bounded by a plasma membrane that separates the interior from the surrounding environment and controls which ' +
    'substances enter and leave. Inside, the cytoplasm hosts organelles such as mitochondria, which produce ATP through ' +
    'oxidative phosphorylation, and the endoplasmic reticulum, which folds and transports proteins destined for secretion. ' +
    'The nucleus stores the genetic material and coordinates gene expression, while ribosomes assemble polypeptide chains. ' +
    'Cells reproduce by division, and they maintain homeostasis by regulating their internal chemistry within narrow limits.';
  const chapterB =
    'Chapter 2: Tissues. A tissue is a group of similar cells that work together to perform a shared function. ' +
    'Epithelial tissue covers surfaces and lines cavities, forming protective barriers and secretory glands. Connective tissue, ' +
    'including bone, cartilage, fat and blood, supports and binds other structures and transports nutrients. Muscular tissue ' +
    'generates force and movement through the contraction of actin and myosin filaments. Nervous tissue conducts electrical ' +
    'impulses, allowing rapid communication between distant parts of the body. Each tissue type arises from specific germ ' +
    'layers during embryonic development, and they combine to form the organs of every body system.';

  const ingest = await call('POST', '/api/ai/ingest-book', {
    token,
    timeoutMs: 60000,
    body: {
      mode: 'text',
      title: 'Smoke Test Book',
      subject: 'Histology',
      author: 'Smoke Test',
      text: `${chapterA}\n\n${chapterB}`,
    },
  });

  if (ingest.status === 200 && ingest.data?.bookId && ingest.data.chapters >= 1) {
    ok('text ingest', `book created with ${ingest.data.chapters} chapters`);
    const del = await call('DELETE', `/api/books/${ingest.data.bookId}`, { token });
    ok('book delete', del.status === 200 ? 'cleaned up' : `unexpected status ${del.status}`);
  } else {
    fail('text ingest', `status ${ingest.status}: ${JSON.stringify(ingest.data)}`);
  }
} catch (error) {
  fail('text ingest', error.message);
}

// ── 7. planner + attempts ────────────────────────────────────────────────────

try {
  const planner = await call('GET', '/api/planner', { token });
  if (planner.status === 200) {
    ok('planner', `due: ${planner.data.dueCount}, chapters: ${planner.data.totalChapters}`);
  } else {
    fail('planner', `status ${planner.status}`);
  }
} catch (error) {
  fail('planner', error.message);
}

// ── 8. account deletion (cleanup) ────────────────────────────────────────────

try {
  const deleted = await call('DELETE', '/api/account', { token });
  if (deleted.status === 200) {
    ok('account deletion', 'test account removed');
  } else {
    fail('account deletion', `status ${deleted.status}`);
  }
} catch (error) {
  fail('account deletion', error.message);
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(failed === 0 ? '\nALL CHECKS PASSED\n' : `\n${failed} CHECK(S) FAILED\n`);
process.exitCode = failed === 0 ? 0 : 1;
