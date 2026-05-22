import { StateGraph, Annotation, START, END, interrupt, MemorySaver } from '@langchain/langgraph';
import { personaPickerChain, recommendMessageChain, augmentPromptChain } from './gemini.mjs';
import { generateSongRunnable, getSongStatusRunnable } from './music-gpt.mjs';
import personas from './personas.mjs';
import { setTimeout as delay } from 'node:timers/promises';

/*
 * LangGraph로 전체 파이프라인을 그래프로 표현한다.
 *
 *   START
 *     ↓
 *   personaMatch       (Multi-Agent: pickerAgent → recommenderAgent)
 *     ↓
 *   promptAugment      (LCEL chain: augmentPromptChain)
 *     ↓
 *   confirmGate        (HITL: interrupt — 사용자에게 prompt 확인을 받음)
 *     ↓
 *   musicGptCall       (Tool: generateSongRunnable)
 *     ↓
 *   pollStatus  ←──┐   (Tool: getSongStatusRunnable)
 *     ↓           │   조건 분기:
 *   (done?)       │     status === 'done' or 시도횟수 초과 → END
 *     ├──no───────┘     else → 자기 자신 (self-loop)
 *     └─→ END
 *
 * 상태(State)는 노드 간에 정의된 reducer를 통해 누적 갱신된다.
 * checkpointer(MemorySaver)는 interrupt() 후 그래프를 resume하기 위해 필요.
 */

// ------------------------------------------------------------------
// State 정의 — Annotation.Root
// ------------------------------------------------------------------
const PipelineState = Annotation.Root({
  // 입력
  description: Annotation(),
  userMessage: Annotation(), // 노래로 만들고 싶은 자유 텍스트

  // personaMatch 결과
  persona: Annotation(),
  personaIndex: Annotation(),
  recommendationMessage: Annotation(),

  // promptAugment 결과
  augmentedPrompt: Annotation(), // { answer, prompt, genre }

  // musicGptCall 결과
  jobId: Annotation(),
  eta: Annotation(),

  // pollStatus 상태
  pollAttempts: Annotation({
    reducer: (prev, next) => next ?? prev ?? 0,
    default: () => 0,
  }),
  status: Annotation(), // 'processing' | 'done' | 'failed'
  result: Annotation(), // { title, songUrl, albumCoverUrl, lyrics }

  // HITL 응답
  userConfirmed: Annotation(),
});

// ------------------------------------------------------------------
// 노드 구현
// ------------------------------------------------------------------

// 1. personaMatch — Multi-Agent: pickerAgent → recommenderAgent
async function personaMatchNode(state) {
  console.log('[graph] personaMatch (Multi-Agent: picker → recommender)');

  // Agent 1: 페르소나 인덱스 선택
  const picked = await personaPickerChain.invoke({
    description: state.description,
    personas: JSON.stringify(personas, null, 2),
  });
  const idx = picked.personaIndex;
  const persona = personas[idx];

  // Agent 2: 선택된 페르소나를 가지고 한국어 추천 메시지 작성
  const recommended = await recommendMessageChain.invoke({
    description: state.description,
    persona: JSON.stringify(persona),
  });

  return {
    personaIndex: idx,
    persona,
    recommendationMessage: recommended.recommendationMessage,
  };
}

// 2. promptAugment — augmentPromptChain
async function promptAugmentNode(state) {
  console.log('[graph] promptAugment');
  const result = await augmentPromptChain.invoke({
    prompt: state.userMessage,
    persona: state.persona?.persona ?? '',
    arts_persona: state.persona?.arts_persona ?? '',
  });
  return { augmentedPrompt: result };
}

// 3. confirmGate — Human-in-the-loop
//    interrupt()는 그래프를 일시정지하고, 외부에서 Command({resume: ...})로 재개.
//    면접 1분 답변용: "augmented prompt를 그대로 MusicGPT에 넘기기 전에
//    사람이 확인할 수 있는 체크포인트를 LangGraph의 HITL 패턴으로 구현"
async function confirmGateNode(state) {
  console.log('[graph] confirmGate (HITL interrupt)');
  const userInput = interrupt({
    question: '이 augmented prompt로 노래를 생성할까요?',
    augmentedPrompt: state.augmentedPrompt,
    persona: state.persona?.name,
  });
  // userInput은 외부에서 resume할 때 넘긴 값.
  return { userConfirmed: userInput === true || userInput === 'yes' };
}

// 4. musicGptCall — generateSongRunnable
async function musicGptCallNode(state) {
  console.log('[graph] musicGptCall');
  if (state.userConfirmed === false) {
    return { status: 'failed', result: { reason: 'user declined' } };
  }
  // Dry-run 지원: 실제 MusicGPT 호출 비용/시간 회피용
  if (process.env.GRAPH_DRY_RUN === '1') {
    return {
      jobId: 'dry-' + Date.now(),
      eta: 1,
      status: 'processing',
    };
  }
  const result = await generateSongRunnable.invoke({
    prompt: state.augmentedPrompt?.prompt ?? '',
    music_style: state.augmentedPrompt?.genre ?? '',
  });
  return {
    jobId: result?.task_id,
    eta: result?.eta,
    status: 'processing',
  };
}

// 5. pollStatus — 5초 대기 후 상태 확인. 완료까지 self-loop.
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 60; // 5초 × 60 = 5분

async function pollStatusNode(state) {
  const attempt = (state.pollAttempts ?? 0) + 1;
  console.log(`[graph] pollStatus (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`);
  await delay(POLL_INTERVAL_MS);

  // Dry-run 모드: 2번째 시도에서 완료 처리
  if (process.env.GRAPH_DRY_RUN === '1') {
    if (attempt >= 2) {
      return {
        pollAttempts: attempt,
        status: 'done',
        result: {
          title: 'Dry-Run Song',
          songUrl: 'https://example.com/song.mp3',
          albumCoverUrl: 'https://example.com/cover.png',
          lyrics: [{ text: 'la la la', start: 0 }],
        },
      };
    }
    return { pollAttempts: attempt, status: 'processing' };
  }

  const raw = await getSongStatusRunnable.invoke(state.jobId);
  const c = raw?.conversion;
  const completed =
    (c?.status === 'COMPLETED' || c?.status === 'GENERATION_COMPLETED') &&
    typeof c?.title_1 === 'string' &&
    typeof c?.conversion_path_1 === 'string' &&
    typeof c?.album_cover_path === 'string' &&
    typeof c?.lyrics_timestamped_1 === 'string';

  if (completed) {
    return {
      pollAttempts: attempt,
      status: 'done',
      result: {
        title: c.title_1,
        songUrl: c.conversion_path_1,
        albumCoverUrl: c.album_cover_path,
        lyrics: JSON.parse(c.lyrics_timestamped_1),
      },
    };
  }
  return { pollAttempts: attempt, status: 'processing' };
}

// 조건 분기: poll loop 종료 판단
function pollDoneRouter(state) {
  if (state.status === 'done' || state.status === 'failed') return END;
  if ((state.pollAttempts ?? 0) >= MAX_POLL_ATTEMPTS) return END;
  return 'pollStatus';
}

// ------------------------------------------------------------------
// 그래프 빌드
// ------------------------------------------------------------------
export function buildPipelineGraph() {
  const builder = new StateGraph(PipelineState)
    .addNode('personaMatch', personaMatchNode)
    .addNode('promptAugment', promptAugmentNode)
    .addNode('confirmGate', confirmGateNode)
    .addNode('musicGptCall', musicGptCallNode)
    .addNode('pollStatus', pollStatusNode)
    .addEdge(START, 'personaMatch')
    .addEdge('personaMatch', 'promptAugment')
    .addEdge('promptAugment', 'confirmGate')
    .addEdge('confirmGate', 'musicGptCall')
    .addEdge('musicGptCall', 'pollStatus')
    .addConditionalEdges('pollStatus', pollDoneRouter, ['pollStatus', END]);

  // interrupt() 사용을 위해 checkpointer 필수
  return builder.compile({ checkpointer: new MemorySaver() });
}
