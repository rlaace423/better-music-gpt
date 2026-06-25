# Migration: Google GenAI SDK → LangChain.js + LangGraph

> 이 문서는 면접에서 "왜 LangChain?", "Multi-Agent 어떻게?", "HITL을 어디에?" 같은 질문에
> 1분 안에 답할 수 있도록 핵심 설계 결정을 압축해서 정리한 것이다.

## 한 줄 요약

- **Phase 1 (LangChain.js)**: Google GenAI SDK 직접 호출 → **LCEL 체인**(`ChatPromptTemplate | model | parser`)으로 재구성. 구조화 출력은 `withStructuredOutput(Zod)`, JSON 응답은 `JsonOutputParser` + 후처리 `RunnableLambda`로. 외부 API(MusicGPT)는 `RunnableLambda`로 감싸 동일한 인터페이스에 흡수.
- **Phase 2 (LangGraph)**: 단일 흐름이던 파이프라인을 **StateGraph**(5 노드)로 그래프화. 페르소나 매칭을 **2-agent 오케스트레이션**(picker → recommender)으로 분리해 Multi-Agent 패턴을 명시. `interrupt()` + `MemorySaver`로 **HITL** 체크포인트 도입. 폴링은 **조건 분기 self-loop**.

## Before → After 매핑표

| 개념 | Before (`@google/genai`) | After (LangChain.js / LangGraph) |
|---|---|---|
| LLM 클라이언트 | `new GoogleGenAI({ apiKey })` | `new ChatGoogleGenerativeAI({ apiKey, model })` |
| 시스템 지시 | `config.systemInstruction: string` | `ChatPromptTemplate.fromMessages([['system', …], ['human', …]])` |
| 구조화 출력 | `config.responseSchema: { type: OBJECT, properties: {…} }` | `model.withStructuredOutput(zodSchema)` |
| JSON 응답 파싱 | `response.text` substring slice (`response.indexOf('{')` … `lastIndexOf('}')`) | `JsonOutputParser` (정식 파서) |
| 응답 후처리 | 함수 본문에서 inline | `RunnableLambda.from(fn)`을 LCEL 파이프 마지막 단계로 |
| 다단계 파이프라인 | Express 핸들러에서 `await a(); await b();` 순차 호출 | `LangGraph StateGraph`의 노드 + 엣지 |
| 폴링 루프 | 핸들러 내부 `while (true) { await fetch; await sleep; }` | `pollStatus` 노드 + `addConditionalEdges`로 self-loop |
| 사람 확인 | 클라이언트 측에서 직접 확인 후 다음 fetch | `interrupt()` + `MemorySaver` 기반 그래프 일시정지/재개 |
| MusicGPT 호출 | `async function generateSong(body) { return axios.post(...); }` | `RunnableLambda.from(generateSongImpl)` (LCEL/그래프 노드와 호환) |

## 그래프 구조 (Phase 2)

```
                          ┌─────────────────────────────────────────┐
                          │ State (Annotation.Root)                 │
                          │  description, userMessage,              │
                          │  persona, personaIndex, recommendation, │
                          │  augmentedPrompt,                       │
                          │  jobId, eta, pollAttempts (reducer),    │
                          │  status, result, userConfirmed          │
                          └─────────────────────────────────────────┘

   START
     │
     ▼
  ┌─────────────────────────────────────────┐
  │ personaMatch    (Multi-Agent)           │
  │   ① personaPickerChain                  │   ← Zod: { personaIndex }
  │       (description + 페르소나 5개 → 인덱스) │
  │   ② recommendMessageChain               │   ← Zod: { recommendationMessage }
  │       (description + 선택 persona → 한국어 메시지) │
  └─────────────────────────────────────────┘
     │
     ▼
  ┌─────────────────────────────────────────┐
  │ promptAugment   (LCEL chain)            │
  │   augmentPromptChain                    │
  │     ChatPromptTemplate                  │
  │       │ pipe                            │
  │     ChatGoogleGenerativeAI              │
  │       │ pipe                            │
  │     JsonOutputParser                    │
  │       │ pipe                            │
  │     RunnableLambda (200자 cap)          │
  └─────────────────────────────────────────┘
     │
     ▼
  ┌─────────────────────────────────────────┐
  │ confirmGate     (HITL)                  │
  │   interrupt({ augmentedPrompt, ... })   │   ← 사용자가 prompt 확인할 때까지 그래프 pause
  │   resume시 Command({resume: true|false})로  │
  │   userConfirmed 상태에 반영              │
  └─────────────────────────────────────────┘
     │
     ▼
  ┌─────────────────────────────────────────┐
  │ musicGptCall    (Tool wrapped)          │
  │   generateSongRunnable.invoke(...)      │   ← RunnableLambda
  │   userConfirmed===false 면 즉시 실패 분기   │
  └─────────────────────────────────────────┘
     │
     ▼
  ┌─────────────────────────────────────────┐
  │ pollStatus      (Tool wrapped, 5s sleep)│  ◀──┐
  │   getSongStatusRunnable.invoke(jobId)   │     │ self-loop
  │   상태 누적: pollAttempts (reducer)      │     │
  └─────────────────────────────────────────┘     │
     │                                            │
     ▼ addConditionalEdges                        │
   ┌──────────────────────────────┐               │
   │ pollDoneRouter(state):       │               │
   │   status === 'done'/'failed' │               │
   │   or attempts ≥ 60 → END     │               │
   │   else → 'pollStatus' ───────┼───────────────┘
   └──────────────────────────────┘
     │
     ▼
    END
```

## 면접 답변 스크립트 (1분)

### Q1. "왜 SDK 직접 호출 대신 LangChain을 도입했어요?"

세 가지 이유가 있습니다.

1. **JSON 응답 파싱의 안정화**: 기존엔 모델 응답 텍스트에서 `{`와 `}` 사이를 substring으로 잘라
   `JSON.parse` 하는 안전망을 직접 만들고 있었습니다. LangChain의 `JsonOutputParser`로 그 책임을 옮기고,
   200자 제한 같은 도메인 후처리만 `RunnableLambda` 한 줄로 LCEL 파이프 마지막에 붙였습니다.
   결과적으로 비즈니스 코드에서 파싱 로직이 사라지고 체인 정의만 남습니다.

2. **구조화 출력의 1급 표현**: 기존 `responseSchema`(provider별 비표준 JSON 스키마)를
   `withStructuredOutput(zodSchema)`로 교체했습니다. Zod 스키마가 타입·기본값·`.describe()`로 의도까지
   같이 표현하므로, "프롬프트가 이 형식을 강제한다"를 코드 한 곳에 모을 수 있고 provider를 바꿔도
   재사용됩니다.

3. **다단계/그래프로의 확장성**: 모든 LLM 호출과 외부 API가 동일한 `Runnable` 인터페이스
   (`.invoke`, `.pipe`)를 가지면 Phase 2의 LangGraph 노드로 그대로 흡수할 수 있습니다.
   실제로 Phase 1의 체인들이 Phase 2 그래프에서 변경 없이 노드로 재사용됐습니다.

### Q2. "Multi-Agent 오케스트레이션은 구체적으로 어디에 있나요?"

`personaMatch` 노드입니다.

원래는 한 번의 LLM 호출로 `{ personaIndex, recommendationMessage }` 두 가지를 동시에 받았는데,
이를 **두 개의 LLM Agent로 분리**했습니다.

- `personaPickerChain`: description + 페르소나 5개 → **인덱스 선택만** (Zod `{ personaIndex }`)
- `recommendMessageChain`: description + 선택된 persona → **한국어 추천 메시지만** (Zod `{ recommendationMessage }`)

LangGraph 노드(`personaMatchNode`) 내부에서 두 agent를 순차 호출하고 결과를 State에 합칩니다.

책임을 분리한 실익:
- 각 agent의 프롬프트가 더 짧고 명확해지면서 환각이 줄어듭니다.
- picker 결과를 검증해 잘못된 인덱스면 recommender를 호출하지 않고 fallback 가능합니다.
- 추후 picker만 더 가벼운 모델로 교체하는 식의 cost optimization이 자연스러워집니다.

### Q3. "Human-in-the-loop은 어디에 어떻게?"

`confirmGate` 노드입니다. augmented prompt가 만들어진 직후, **MusicGPT에 비용·시간 드는 호출을 보내기 전에**
사용자가 확인할 체크포인트를 두었습니다.

LangGraph의 `interrupt()`를 노드 안에서 호출하면 그래프 실행이 정지되고,
`MemorySaver` checkpointer에 현재 State가 저장됩니다. 외부에서
`graph.invoke(new Command({ resume: userInput }), threadConfig)`로 재개하면, `interrupt()`의 반환값이
바로 그 `userInput`이 되어 State 업데이트로 이어집니다.

CLI 데모(`examples/run-graph.mjs`)에서 이 흐름을 시연합니다. 첫 `invoke()`가 interrupt까지 진행한 뒤,
`graph.getState(threadConfig)`로 pending interrupt를 꺼내 사용자에게 보여주고,
y/N 응답을 받아 `Command({ resume: bool })`로 같은 thread_id에 재개합니다.

### Q4. "조건 분기 / 루프는?"

`pollStatus` 노드와 `pollDoneRouter`입니다. `addConditionalEdges('pollStatus', router, ['pollStatus', END])`로
완료 전까지 자기 자신으로 돌아오는 self-loop를 만들고, `status === 'done'`이거나 시도 60회를 넘으면
END로 빠져나갑니다. `pollAttempts`는 Annotation에 reducer를 명시적으로 정의해서 노드가 반환한 값으로 누적됩니다.

## 정직성 — 한 게 아닌 것

이력서/면접에서 과장하지 않기 위해 명확히:

- **Express API는 그래프에 통합하지 않았다.** 기존 `/api/*` 라우트는 LCEL 체인을 직접 호출한다(Phase 1까지).
  그래프는 `examples/run-graph.mjs`로 별도 진입점에서 시연. 통합은 후속 작업.
- **Multi-Agent라고 부르긴 하지만 ReAct/tool-calling agent는 쓰지 않았다.** 두 agent가 순차로
  배치된 deterministic orchestration이다 (LangGraph 노드 두 단계). 자율적 도구 선택은 없다.
- **MusicGPT는 Tool로 노출하지 않았다.** `RunnableLambda`로 감싸기만 했다.
  agent에게 도구 선택권을 줄 필요가 없는 흐름이라 honesty 차원에서 Tool 추상화는 의도적으로 빼뒀다.

## 명령어

```bash
# 일반 서버 실행 (Phase 1 + 기존 API 유지)
npm start

# 스모크 테스트 (.env 필요)
npm run smoke

#   스모크 — 구조만 (LLM 호출 안 함, dummy key로 부팅 검증)
GEMINI_API_KEY=dummy MUSIC_GPT_API_KEY=dummy SKIP_LLM_TESTS=1 npm run smoke

# 그래프 CLI 데모 — 실제 호출 (.env 필요)
node examples/run-graph.mjs

# 그래프 CLI 데모 — MusicGPT 호출 mock (Gemini는 진짜, .env에 GEMINI_API_KEY 필요)
node examples/run-graph.mjs --dry
```

## 다음 단계 (TODO, 면접에서 물어보면 답할 거리)

1. Express에 `/api/run-pipeline` 신설 — 그래프 thread_id 단위로 SSE/WebSocket 스트리밍.
2. LangSmith tracing 켜기 (`LANGCHAIN_TRACING_V2=true`) → 각 노드/agent 호출 추적.
3. `personaPickerChain`을 더 가벼운 모델(예: `gemini-2.5-flash-lite`)로 교체해 cost split.
4. `MemorySaver` → SQLite/Postgres checkpointer로 영속화 (HITL의 재시작 견고성).
5. ReAct agent 도입 — "DB에서 사용자 청취 이력 조회 후 페르소나 추론" 같은 자율적 tool 사용 시나리오.
