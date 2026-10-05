// Plays a group-study room as the "Test Friend" account: joins with the code
// and answers every question as fast as possible. The host controls the pace.
//
// Usage: node scripts/group-friend.js <CODE> [optionIndex]

const base = process.env.SMOKE_URL ?? 'https://athena-api-w018.onrender.com';
const code = String(process.argv[2] ?? '').toUpperCase();
const optionIndex = Number(process.argv[3] ?? 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!code) {
  console.error('Usage: node scripts/group-friend.js <CODE> [optionIndex]');
  process.exit(1);
}

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
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

const auth = await call('POST', '/api/auth/signin', {
  body: { email: 'group-test@athena.dev', password: 'password123' },
});
if (auth.status !== 200) {
  console.error(`sign-in failed: ${auth.status}`);
  process.exit(1);
}
const token = auth.data.token;

const joined = await call('POST', `/api/group/rooms/${code}/join`, {
  token,
  body: { name: 'Test Friend' },
});
console.log(`joined room ${code}: ${joined.status}`);
if (joined.status !== 200) process.exit(1);

console.log('playing… (answers instantly, waits for the host)');
const answered = new Set();

for (let round = 0; round < 240; round++) {
  const state = await call('GET', `/api/group/rooms/${code}`, { token });
  if (state.status !== 200) {
    console.log(`poll failed: ${state.status}`);
    await sleep(1500);
    continue;
  }

  const room = state.data.room;
  if (room.status === 'finished') {
    const ranked = [...state.data.players].sort(
      (a, b) => b.score - a.score || a.totalMs - b.totalMs,
    );
    console.log('game finished!');
    for (const [index, player] of ranked.entries()) {
      console.log(`  ${index + 1}. ${player.name}: ${player.score} pts (${player.correctCount} correct)`);
    }
    process.exit(0);
  }

  if (room.phase === 'question' && !answered.has(room.currentIndex)) {
    const result = await call('POST', `/api/group/rooms/${code}/answer`, {
      token,
      body: { questionIndex: room.currentIndex, optionIndex },
    });
    if (result.status === 200) {
      answered.add(room.currentIndex);
      console.log(
        `  Q${room.currentIndex + 1}: answered in ${result.data.elapsedMs}ms — ${
          result.data.correct ? `correct +${result.data.points}` : 'wrong'
        }`,
      );
    } else if (result.status === 409) {
      answered.add(room.currentIndex);
    }
  }

  await sleep(900);
}

console.log('gave up after 240 rounds');
