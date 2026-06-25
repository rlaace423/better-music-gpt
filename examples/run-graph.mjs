/*
 * Phase 2 (LangGraph) 데모 CLI.
 *
 * 그래프 전체 흐름을 CLI에서 직접 실행해본다.
 * Multi-Agent (personaMatch) → LCEL (promptAugment) → HITL (confirmGate) → Tool (musicGptCall) → 조건 분기 self-loop (pollStatus).
 *
 * 사용법:
 *   node examples/run-graph.mjs --dry           # MusicGPT 호출 없이 mock 응답으로 전체 그래프 시연
 *   node examples/run-graph.mjs                  # 실제 MusicGPT 호출 (시간/비용 발생)
 *
 * 환경변수:
 *   GEMINI_API_KEY  필수 (.env 또는 셸 export)
 *   MUSIC_GPT_API_KEY  --dry 가 아니면 필요
 */

import { Command } from '@langchain/langgraph';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildPipelineGraph } from '../graph.mjs';

const argv = new Set(process.argv.slice(2));
if (argv.has('--dry')) {
  process.env.GRAPH_DRY_RUN = '1';
  console.log('[demo] DRY-RUN: MusicGPT 호출은 mock 됩니다.');
}

async function ask(rl, q) {
  const answer = await rl.question(q);
  return answer.trim();
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  const description = await ask(rl, '당신을 한 줄로 소개해주세요 (페르소나 매칭에 사용):\n> ');
  const userMessage = await ask(rl, '\n노래로 만들고 싶은 이야기/감정:\n> ');

  const graph = buildPipelineGraph();
  const threadConfig = { configurable: { thread_id: 'demo-' + Date.now() } };

  console.log('\n[demo] 그래프 실행 시작...\n');

  // 1) 첫 invoke — interrupt까지 진행
  let state = await graph.invoke({ description, userMessage }, threadConfig);

  // 2) 인터럽트 상태인지 확인. tasks에 interrupt가 남아있으면 HITL 대기.
  let snapshot = await graph.getState(threadConfig);
  const hasInterrupt = snapshot.tasks?.some((t) => t.interrupts && t.interrupts.length > 0) ?? false;

  if (hasInterrupt) {
    const interruptPayload = snapshot.tasks.flatMap((t) => t.interrupts ?? []).map((i) => i.value)[0];
    console.log('\n[HITL] 그래프가 사용자 확인을 대기 중입니다.');
    console.log('  - 페르소나:', interruptPayload?.persona);
    console.log('  - augmentedPrompt.answer:', interruptPayload?.augmentedPrompt?.answer);
    console.log('  - augmentedPrompt.prompt:', interruptPayload?.augmentedPrompt?.prompt);
    console.log('  - augmentedPrompt.genre:', interruptPayload?.augmentedPrompt?.genre);

    const yes = (await ask(rl, '\n이대로 노래를 생성할까요? (y/N): ')).toLowerCase();
    const resumeWith = yes === 'y' || yes === 'yes';

    console.log(`\n[demo] resume with userConfirmed=${resumeWith}\n`);
    state = await graph.invoke(new Command({ resume: resumeWith }), threadConfig);
  }

  rl.close();

  console.log('\n[demo] === 최종 상태 ===');
  console.log('status:', state.status);
  console.log('persona:', state.persona?.name);
  console.log('recommendationMessage:', state.recommendationMessage);
  console.log('jobId:', state.jobId);
  console.log('pollAttempts:', state.pollAttempts);
  console.log('result:', state.result);
}

main().catch((e) => {
  console.error('[demo] FAILED:', e);
  process.exit(1);
});
