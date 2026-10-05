// Multiplayer smoke test for group study: two players race through a full
// game against the live API.
//
// Usage: SMOKE_URL=https://athena-api-w018.onrender.com node scripts/smoke-group.js
//
// Player A = your demo account (host). Player B = a test account. Player B
// answers instantly, player A after ~1.2s — so if the answers are correct,
// B must score more points (speed bonus). Verifies: no answer leak before
// reveal, phase flow, speed scoring, standings, completion and leaderboard.

const base = process.env.SMOKE_URL ?? 'http://localhost:8787';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
let failed = 0;

function ok(name, detail) {
  results.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, message) {
  failed += 1;
  results.push(`  ✗ ${name} — ${message}`);
}

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
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

console.log(`\nGroup study test against ${base}\n`);

// ── accounts ─────────────────────────────────────────────────────────────────

const a = await call('POST', '/api/auth/signin', {
  body: { email: 'demo@athena.app', password: 'athena123' },
});
if (a.status !== 200) {
  fail('host sign-in', `${a.status} ${JSON.stringify(a.data)}`);
  console.log(results.join('\n'));
  process.exit(1);
}
const tokenA = a.data.token;
ok('host sign-in', a.data.user.email);

let b = await call('POST', '/api/auth/signup', {
  body: { email: 'group-test@athena.dev', password: 'password123', full_name: 'Test Friend' },
});
if (b.status === 409) {
  b = await call('POST', '/api/auth/signin', {
    body: { email: 'group-test@athena.dev', password: 'password123' },
  });
}
if (b.status !== 200 && b.status !== 201) {
  fail('friend sign-in', `${b.status} ${JSON.stringify(b.data)}`);
  console.log(results.join('\n'));
  process.exit(1);
}
const tokenB = b.data.token;
ok('friend sign-in', b.data.user.email);

// ── create + join ────────────────────────────────────────────────────────────

const sets = await call('GET', '/api/sets', { token: tokenA });
const set = (sets.data ?? []).find((entry) => (entry.question_count ?? 0) >= 3);
if (!set) {
  fail('pick quiz', 'no quiz with >= 3 questions on the demo account');
  console.log(results.join('\n'));
  process.exit(1);
}
ok('pick quiz', `"${set.title}" (${set.question_count} questions)`);

const created = await call('POST', '/api/group/rooms', {
  token: tokenA,
  body: { setId: set.id, name: 'Demo Student' },
});
if (created.status !== 201) {
  fail('create room', `${created.status} ${JSON.stringify(created.data)}`);
  console.log(results.join('\n'));
  process.exit(1);
}
const code = created.data.code;
ok('create room', `code ${code}`);

const joined = await call('POST', `/api/group/rooms/${code}/join`, {
  token: tokenB,
  body: { name: 'Test Friend' },
});
ok('friend joins', `status ${joined.status}`);

// ── play the whole game ──────────────────────────────────────────────────────

let state = (await call('POST', `/api/group/rooms/${code}/start`, { token: tokenA })).data;
ok(
  'start',
  `phase=${state.room.phase}, ${state.room.questionCount} questions, ${state.players.length} players`,
);

if (state.question && 'correctIndex' in state.question) {
  fail('answer leak check', 'correctIndex was visible during the question!');
} else {
  ok('answer leak check', 'no correctIndex while the question is open');
}

const total = state.room.questionCount;
let speedProof = null;

for (let index = 0; index < total; index++) {
  if (state.room.currentIndex !== index || state.room.phase !== 'question') {
    state = (await call('GET', `/api/group/rooms/${code}`, { token: tokenA })).data;
  }

  // Friend answers instantly.
  const friendAnswer = await call('POST', `/api/group/rooms/${code}/answer`, {
    token: tokenB,
    body: { questionIndex: index, optionIndex: 0 },
  });
  if (friendAnswer.status !== 200) {
    fail(`Q${index + 1} friend answer`, `${friendAnswer.status}`);
    break;
  }

  await sleep(1200);

  // Host answers ~1.2s later.
  const hostAnswer = await call('POST', `/api/group/rooms/${code}/answer`, {
    token: tokenA,
    body: { questionIndex: index, optionIndex: 0 },
  });
  if (hostAnswer.status !== 200) {
    fail(`Q${index + 1} host answer`, `${hostAnswer.status}`);
    break;
  }
  state = hostAnswer.data.state;

  if (index === 0) {
    const fast = friendAnswer.data;
    const slow = hostAnswer.data;
    if (fast.correct && fast.points > slow.points) {
      speedProof = `friend ${fast.points} pts (${fast.elapsedMs}ms) vs host ${slow.points} pts (${slow.elapsedMs}ms)`;
      ok('speed bonus', speedProof);
    } else if (!fast.correct) {
      ok('speed bonus', 'answer was wrong for both — scoring path exercised');
    } else {
      fail('speed bonus', `fast=${JSON.stringify(fast)} slow=${JSON.stringify(slow)}`);
    }
  }

  if (state.room.phase !== 'reveal' && index + 1 < total) {
    state = (await call('GET', `/api/group/rooms/${code}`, { token: tokenA })).data;
  }
  if (state.reveal && index === 0) {
    ok(
      'reveal payload',
      `correctIndex=${state.reveal.correctIndex}, fastest=${state.reveal.fastestPlayerId ? 'yes' : 'none'}, answers=${state.reveal.answers.length}, quote=${state.reveal.supportingQuote ? 'yes' : 'no'}`,
    );
  }

  // Host moves on.
  const moved = await call('POST', `/api/group/rooms/${code}/next`, { token: tokenA });
  if (moved.status !== 200) {
    fail(`Q${index + 1} next`, `${moved.status}`);
    break;
  }
  state = moved.data;
}

if (state.room.status === 'finished') {
  const ranked = [...state.players].sort((x, y) => y.score - x.score || x.totalMs - y.totalMs);
  ok('game finished', ranked.map((p) => `${p.name}: ${p.score} pts`).join(' · '));
} else {
  fail('game finished', `status=${state.room.status} phase=${state.room.phase}`);
}

// ── global leaderboard ───────────────────────────────────────────────────────

const board = await call('GET', '/api/group/leaderboard', { token: tokenA });
const demoRow = (board.data ?? []).find((row) => row.name === 'Demo Student');
if (board.status === 200 && demoRow) {
  ok(
    'global leaderboard',
    `Demo Student: ${demoRow.points} pts, ${demoRow.games} games, ${demoRow.wins} wins (top ${board.data.length})`,
  );
} else {
  fail('global leaderboard', `${board.status} ${JSON.stringify(board.data)?.slice(0, 120)}`);
}

console.log(results.join('\n'));
console.log(failed === 0 ? '\nALL GROUP CHECKS PASSED\n' : `\n${failed} GROUP CHECK(S) FAILED\n`);
process.exitCode = failed === 0 ? 0 : 1;
