/*
 * Smoke test — LangChain.js 마이그레이션 회귀 검증용.
 *
 * 사용법:
 *   npm run smoke
 *
 * 동작:
 *   1) 서버를 자식 프로세스로 띄움 (포트 충돌 회피 위해 PORT=5599)
 *   2) /api/personas        : LLM 무관, 페르소나 5개 반환되는지
 *   3) /api/find-persona    : Gemini structured output. result.persona가 객체로 오는지
 *   4) /api/generate-prompt : Gemini JsonOutputParser. answer/prompt/genre 모두 있는지,
 *                              prompt.length가 200자 이하인지
 *   5) /api/generate-song, /api/get-song-status 는 실제 MusicGPT 호출이라 비용/시간 부담 →
 *      라우트 등록 여부만 가볍게 확인 (잘못된 입력으로 400/500 받는 정도)
 *
 * 환경변수:
 *   GEMINI_API_KEY    : 진짜 Gemini 호출에 사용. 누락 시 서버 부팅 자체가 실패하므로,
 *                       smoke 단독 실행 시 더미 키로라도 채워야 한다 (구조 검증 모드).
 *   SKIP_LLM_TESTS=1  : LLM 호출 테스트(find-persona, generate-prompt)를 skip.
 *                       더미 키로 부팅만 확인할 때 사용.
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = process.env.SMOKE_PORT || '5599';
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok ? '✅' : '❌';
  console.log(`${tag} ${name}${detail ? '  — ' + detail : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/personas`);
      if (r.ok) return;
    } catch {
      // ignore connection refused
    }
    await delay(250);
  }
  throw new Error(`server did not come up within ${timeoutMs}ms`);
}

async function testPersonas() {
  const r = await fetch(`${BASE}/api/personas`);
  assert(r.ok, `GET /api/personas → ${r.status}`);
  const personas = await r.json();
  assert(Array.isArray(personas), 'personas is not an array');
  assert(personas.length === 5, `expected 5 personas, got ${personas.length}`);
  assert(personas[0].name === 'Quintin', `first persona name mismatch: ${personas[0].name}`);
  record('GET /api/personas', true, `${personas.length} personas`);
}

async function testFindPersona() {
  if (process.env.SKIP_LLM_TESTS === '1') {
    record('POST /api/find-persona', true, 'SKIPPED (SKIP_LLM_TESTS=1)');
    return;
  }
  const r = await fetch(`${BASE}/api/find-persona`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: '저는 조용한 곳에서 책 읽는 것을 좋아하고, 가끔은 새로운 사람들과 어울리는 것도 즐겨요.',
    }),
  });
  assert(r.ok, `POST /api/find-persona → ${r.status}`);
  const body = await r.json();
  assert(typeof body.personaIndex === 'number', 'personaIndex not a number');
  assert(body.personaIndex >= 0 && body.personaIndex < 5, `personaIndex out of range: ${body.personaIndex}`);
  assert(body.persona && typeof body.persona.name === 'string', 'persona object missing');
  assert(typeof body.recommendationMessage === 'string', 'recommendationMessage missing');
  record(
    'POST /api/find-persona',
    true,
    `picked ${body.persona.name} (idx=${body.personaIndex}), msg len=${body.recommendationMessage.length}`,
  );
}

async function testGeneratePrompt() {
  if (process.env.SKIP_LLM_TESTS === '1') {
    record('POST /api/generate-prompt', true, 'SKIPPED (SKIP_LLM_TESTS=1)');
    return;
  }
  // Quintin 페르소나
  const r = await fetch(`${BASE}/api/generate-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: '오늘 너무 더워서 힘들어...',
      persona: 'Quintin, a 40-year-old logistician from Converse, TX, balances curiosity with practicality.',
      arts_persona: "Tejano musician Selena's soulful melodies and David Adickes' sculptures.",
    }),
  });
  assert(r.ok, `POST /api/generate-prompt → ${r.status}`);
  const body = await r.json();
  assert(body.status === 'success', `status not success: ${body.status}`);
  assert(typeof body.answer === 'string' && body.answer.length > 0, 'answer empty');
  assert(typeof body.prompt === 'string' && body.prompt.length > 0, 'prompt empty');
  assert(body.prompt.length <= 200, `prompt > 200 chars: ${body.prompt.length}`);
  assert(typeof body.genre === 'string' && body.genre.length > 0, 'genre empty');
  record(
    'POST /api/generate-prompt',
    true,
    `genre=${body.genre}, promptLen=${body.prompt.length}, answerLen=${body.answer.length}`,
  );
}

async function testGenerateSongRouteRegistered() {
  // 잘못된 입력으로 호출 → 라우트 자체는 등록돼 있어야 함
  // (실제 MusicGPT 호출은 비용/시간 때문에 회피. 401/500/200 어떤 응답이든 라우트 자체는 살아있음 확인)
  const r = await fetch(`${BASE}/api/generate-song`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  // 라우트가 없으면 404. 그 외 status면 통과.
  assert(r.status !== 404, `route missing: ${r.status}`);
  record('POST /api/generate-song (route only)', true, `status=${r.status}`);
}

async function testGetSongStatusRouteRegistered() {
  const r = await fetch(`${BASE}/api/get-song-status`);
  assert(r.status !== 404, `route missing: ${r.status}`);
  record('GET /api/get-song-status (route only)', true, `status=${r.status}`);
}

async function main() {
  console.log(`[smoke] starting server on port ${PORT}...`);
  const server = spawn('node', ['index.mjs'], {
    env: { ...process.env, PORT },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let exited = false;
  server.on('exit', (code) => {
    exited = true;
    console.log(`[smoke] server exited with code ${code}`);
  });

  try {
    await waitForServer();
    await testPersonas();
    await testFindPersona();
    await testGeneratePrompt();
    await testGenerateSongRouteRegistered();
    await testGetSongStatusRouteRegistered();
  } catch (e) {
    console.error('[smoke] FAILED:', e);
    record('OVERALL', false, e.message);
  } finally {
    if (!exited) server.kill('SIGTERM');
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n[smoke] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
