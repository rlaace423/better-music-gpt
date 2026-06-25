# LangChain.js + LangGraph 완전 초보자 가이드

> 이 문서를 읽고 나면 우리가 새로 추가한 `gemini.mjs`, `music-gpt.mjs`, `graph.mjs`, `examples/run-graph.mjs`를
> **한 줄씩** 읽을 수 있게 된다.
>
> 사전 지식: Node.js, `async/await`, JSON, Express 기본기.
> LangChain/LangGraph 경험은 0이라고 가정한다.

---

## 0. 큰 그림 — 우리는 무엇을 했나?

원래 코드:
```
Express 핸들러 안에서
  await googleGenAI.models.generateContent({ ... })  ← Gemini 호출
  ↓ 응답 텍스트
  response.text 에서 { ... } 부분만 잘라서 JSON.parse
  ↓ 그렇게 얻은 prompt
  await axios.post('https://api.musicgpt.com/...')   ← MusicGPT 호출
```

문제는 아니다. 하지만:
- 모든 책임이 라우트 핸들러 안에 뒤섞여 있다.
- JSON 파싱이 손코드(`indexOf('{')` … `lastIndexOf('}')`)다.
- "이 LLM 호출을 다음에 또 쓰고 싶다"고 할 때 재사용이 힘들다.
- "사용자가 중간에 확인하고 진행 여부를 결정"하는 흐름을 넣기가 어렵다.

우리가 한 일은 두 단계로 나뉜다.

1. **Phase 1 — LangChain.js 도입**: LLM 호출을 "재사용 가능한 부품(=Runnable)"으로 바꾸고, 부품들을 **파이프로 연결**해서 체인을 만든다. JSON 파싱을 정식 파서로 교체. (이게 LCEL — LangChain Expression Language)
2. **Phase 2 — LangGraph 도입**: 여러 단계 흐름을 **노드와 엣지로 명시적인 그래프**로 만든다. 폴링 루프, 사람 확인(HITL), 조건 분기를 그래프 구조로 표현.

이제 둘을 차근차근 풀어 본다.

---

## 1. LangChain — 가장 중요한 단어 하나, "Runnable"

LangChain의 모든 것은 **Runnable**이라는 인터페이스를 따른다.

Runnable은 그냥 이런 약속이다:

> "나는 `.invoke(input)` 메서드가 있다. 입력 하나 받으면 출력 하나 돌려준다."

그리고 모든 Runnable은 `.pipe(다음Runnable)`로 연결할 수 있다.
**Unix 셸 파이프와 똑같이** 생각하면 된다:

```bash
# 셸
cat file.txt | grep "error" | wc -l
# 출력의 표준 출력을 다음 명령의 표준 입력으로
```

```js
// LangChain (JS)
const chain = promptTemplate.pipe(model).pipe(parser).pipe(lambda);
const out = await chain.invoke({ description: '...' });
// promptTemplate 출력 → model 입력
// model 출력 → parser 입력
// parser 출력 → lambda 입력
// lambda 출력 → out
```

여기서 `promptTemplate`, `model`, `parser`, `lambda` **전부 Runnable**이다. 같은 인터페이스라서 일자로 꿸 수 있다.

---

## 2. 우리가 쓴 Runnable 다섯 종

### 2-1. `ChatPromptTemplate` — 변수를 끼워 넣을 수 있는 프롬프트

옛날 코드에선 그냥 문자열 템플릿 리터럴로 프롬프트를 만들었다:

```js
// 옛날
const prompt = `User said: "${description}". Personas: ${JSON.stringify(personas)}`;
```

LangChain에선 "이 변수는 나중에 채울 거다"라고 **선언**해 둔다:

```js
import { ChatPromptTemplate } from '@langchain/core/prompts';

const findPersonaPrompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a helpful AI assistant that matches a user to a persona. ...'],
  ['human', `**User's Self-Description:**
"{description}"

**Persona List (JSON):**
{personas}`],
]);
```

- `'system'` / `'human'`은 ChatGPT/Gemini류의 **역할(role)**이다. 시스템 지시는 모델이 "내가 무엇을 하는 사람"인지 받는 메시지, human은 사용자의 입력.
- `{description}`, `{personas}`는 **나중에 채울 자리**. 변수 이름이다.
- 채울 때는 `.invoke({ description: '...', personas: '...' })`로 객체를 넘긴다.

**⚠️ 함정**: 템플릿 안에서 `{`/`}`를 **literal**(진짜 중괄호)로 쓰고 싶으면 `{{`/`}}`로 두 번 적어야 한다. 우리 코드에서 JSON 예시를 보여줄 때 이 트릭을 썼다 (`gemini.mjs`의 `augmentPrompt` 시스템 메시지):

```js
`{{ "answer": "...", "prompt": "...", "genre": "..." }}`
//  └ literal {                                         └ literal }
```

### 2-2. `ChatGoogleGenerativeAI` — Gemini 모델 자체

```js
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

const model = new ChatGoogleGenerativeAI({
  apiKey: config.geminiApiKey,
  model: 'gemini-2.5-flash',
});
```

이게 옛날의 `new GoogleGenAI({ apiKey })`를 대체한다. 차이점:

| | 옛날 (`@google/genai`) | 새것 (`@langchain/google-genai`) |
|---|---|---|
| 호출 | `googleGenAI.models.generateContent({ ... })` | `model.invoke([ { role: 'human', content: '...' } ])` |
| 옵션 | 매 호출마다 `config` 객체 | 생성자에서 한 번 설정 + `.bind()` |
| API 키 누락 | 호출 시점에 fail | **생성자 시점에 throw** ← 우리 smoke 테스트에서 발견한 동작 |
| Runnable인가? | 아님 | **Runnable** (그래서 .pipe로 꿸 수 있음) |

마지막 줄이 핵심이다. 모델이 Runnable이므로 `prompt.pipe(model)`이 그냥 된다.

### 2-3. `JsonOutputParser` — LLM 출력에서 JSON을 안전하게 뽑기

LLM이 "JSON으로만 답해줘"라고 해도 가끔 ` ```json ` 코드 블록으로 감싸거나 앞뒤 설명을 붙인다. 옛날에 우리가 직접 짠 안전망:

```js
// 옛날 gemini.mjs (지운 코드)
function parseResponseText(response) {
  const firstBraceIndex = response.indexOf('{');
  const lastBraceIndex = response.lastIndexOf('}');
  if (firstBraceIndex > -1 && lastBraceIndex > -1 ...) {
    const jsonString = response.slice(firstBraceIndex, lastBraceIndex + 1);
    try { return JSON.parse(jsonString); } catch { return ''; }
  }
}
```

이걸 한 줄로 대체한다:

```js
import { JsonOutputParser } from '@langchain/core/output_parsers';
const parser = new JsonOutputParser();
```

`parser`도 Runnable이므로 `.pipe`로 꿴다. 그러면 `model`의 텍스트 출력이 자동으로 객체로 파싱된다.

### 2-4. `RunnableLambda` — 일반 JS 함수를 Runnable로 둔갑

체인 중간에 "직접 짠 로직"을 끼우고 싶을 때. 우리 코드에선 200자 cap을 적용:

```js
import { RunnableLambda } from '@langchain/core/runnables';

const enforcePromptLimit = RunnableLambda.from((parsed) => {
  if (parsed && typeof parsed.prompt === 'string' && parsed.prompt.length > 200) {
    return { ...parsed, prompt: parsed.prompt.slice(0, 200) };
  }
  return parsed ?? { answer: '', prompt: '', genre: '' };
});
```

이건 그냥 함수 하나인데 `RunnableLambda.from()`으로 감싸면 Runnable이 된다. 그래서 체인 마지막 단계로 `.pipe(enforcePromptLimit)`을 붙일 수 있다. **함수 = 데이터 변환**이라는 게 LCEL의 정신: 모든 단계가 같은 모양으로 보이게 만든다.

`music-gpt.mjs`에서도 똑같이 axios 호출을 Runnable로 감쌌다:
```js
export const generateSongRunnable = RunnableLambda.from(generateSongImpl);
```
이렇게 해두면 나중에 LangGraph 노드에서 그대로 쓸 수 있다.

### 2-5. `model.withStructuredOutput(zodSchema)` — 모델에게 "이 모양으로만 답해"

JsonOutputParser는 "JSON이긴 한데 어떤 모양이든 OK"다. 하지만 우리는 보통 **정확한 스키마**를 원한다 (특히 `personaIndex`는 0~4 정수만 허용 등).

이걸 위해 **Zod**라는 검증 라이브러리로 스키마를 적고, `model.withStructuredOutput(스키마)`를 호출한다:

```js
import { z } from 'zod';

const PersonaPickSchema = z.object({
  personaIndex: z
    .number()
    .int()
    .min(0)
    .max(personas.length - 1)
    .describe('The 0-based index ...'),  // ← 모델이 읽는 설명
  recommendationMessage: z.string().describe('...'),
});

const findPersonaChain = findPersonaPrompt.pipe(
  model.withStructuredOutput(PersonaPickSchema)
);
```

여기서 일어나는 일:
1. LangChain이 Zod 스키마를 Gemini가 이해하는 JSON Schema로 자동 변환한다.
2. 그 스키마를 모델 호출에 함께 넣어 "이 모양으로만 답해"를 강제한다.
3. 모델 응답을 받아 Zod로 한 번 더 검증한다.
4. **타입 안전한 객체**가 나온다 (TypeScript면 `.personaIndex`가 number로 추론됨).

`.describe('...')`는 단순 주석이 아니라 **모델이 읽는 힌트**다. 이게 LLM이 의도를 이해하는 데 결정적이다.

---

## 3. Before / After — `gemini.mjs`

### 3-1. `findPersona` — 페르소나 매칭

**옛날 (요약)**:
```js
const response = await googleGenAI.models.generateContent({
  model: 'gemini-2.5-flash',
  config: {
    systemInstruction: '...',
    responseMimeType: 'application/json',
    responseSchema: { type: Type.OBJECT, properties: { ... }, required: [...] },
  },
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
});
const resultJson = JSON.parse(response.candidates[0].content.parts[0].text);
// 그 다음 personaIndex가 number인지, 범위 안인지 직접 검증
```

**새것**:
```js
// gemini.mjs 라인 47~85
const findPersonaPrompt = ChatPromptTemplate.fromMessages([
  ['system', '...'],
  ['human', '...{description}...{personas}'],
]);

const findPersonaChain = findPersonaPrompt.pipe(
  model.withStructuredOutput(PersonaPickSchema)
);

export async function findPersona(description) {
  try {
    const result = await findPersonaChain.invoke({
      description,
      personas: JSON.stringify(personas, null, 2),
    });
    // 방어적 검증만 살짝
    ...
  } catch (e) { ... }
}
```

읽기 좋아진 것:
- `systemInstruction` 길이가 줄고 역할이 `[system, human]` 두 메시지로 명확.
- `responseSchema`라는 provider별 JSON 객체 대신, **Zod 스키마**(JS 코드)로 표현.
- 응답 JSON 추출과 타입 검증을 LangChain이 알아서 해줌.

### 3-2. `generateAugmentedPrompt` — 프롬프트 증강

**옛날**:
```js
const response = await googleGenAI.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: `<prompt>${prompt}</prompt><persona>${persona}</persona>...`,
  config: { systemInstruction: '... 다음과 같은 JSON 형식으로 ...' },
});
return parseResponseText(response.text);  // 손수 짠 JSON 추출기
```

**새것**:
```js
// gemini.mjs 라인 91~118
const augmentPrompt = ChatPromptTemplate.fromMessages([
  ['system', `너는 음악 생성 AI에 ... 형식: {{ "answer": ..., "prompt": ..., "genre": ... }}`],
  ['human', '<prompt>{prompt}</prompt><persona>{persona}</persona>...'],
]);

const enforcePromptLimit = RunnableLambda.from((parsed) => { ... });

const augmentPromptChain = augmentPrompt
  .pipe(model)               // 프롬프트 → 모델 호출
  .pipe(new JsonOutputParser())  // 모델 출력 텍스트 → JSON 객체
  .pipe(enforcePromptLimit); // JSON 객체 → 200자 cap 적용
```

**한 줄 한 줄이 데이터 변환 한 단계**라는 게 LCEL의 매력이다. 각 단계가 독립적이라 테스트도 쉽다.

이게 왜 면접에서 의미 있냐면, 저 4단계 파이프 자체가 "LangChain의 핵심 추상화"를 한 줄에 보여주는 시연이기 때문.

### 3-3. Multi-Agent 분리 — Phase 2에서 추가됨

여기서부터가 Phase 2 작업이다. 원래는 한 번의 LLM 호출로 두 가지(인덱스 + 추천 메시지)를 동시에 받았는데, 이를 **두 개의 LLM Agent**로 쪼갰다.

```js
// gemini.mjs 라인 134~191
const PersonaIndexSchema = z.object({ personaIndex: z.number().int()... });
export const personaPickerChain = pickerPrompt.pipe(
  model.withStructuredOutput(PersonaIndexSchema)
);
// ↑ Agent 1: 인덱스만 결정

const RecommendationSchema = z.object({ recommendationMessage: z.string()... });
export const recommendMessageChain = recommenderPrompt.pipe(
  model.withStructuredOutput(RecommendationSchema)
);
// ↑ Agent 2: 추천 메시지만 작성
```

이걸 LangGraph의 `personaMatch` 노드 안에서 순차 호출한다. 그게 "Multi-Agent 오케스트레이션"이다.

> ⚠️ 정직성 노트: 진짜 "agent"는 보통 자율적으로 도구를 선택하는 ReAct 패턴을 의미한다.
> 우리는 그 단계까지 가지 않았고, **두 LLM 호출이 사람이 정한 순서로 묶여 있다**.
> 이걸 정직하게 표현하면 "**deterministic multi-agent orchestration**"이다.

---

## 4. Before / After — `music-gpt.mjs`

**옛날**:
```js
export async function generateSong(body) {
  const result = await axios.post(...);
  return result.data;
}
```

**새것**:
```js
async function generateSongImpl(body) { /* 옛날 함수 그대로 */ }

export const generateSongRunnable = RunnableLambda.from(generateSongImpl);

// 기존 호출자(index.mjs) 호환용으로 일반 함수 export도 유지
export async function generateSong(body) {
  return generateSongRunnable.invoke(body);
}
```

핵심:
- 동작은 똑같다.
- 다만 `Runnable`로도 노출되어 있어, LangGraph 노드에서 그대로 `.invoke()` 호출 가능.
- "이게 왜 필요해?" → Phase 2에서 그래프 노드가 이걸 호출한다. 같은 인터페이스로.

---

## 5. Before / After — `index.mjs`

거의 안 바뀐다. Phase 1의 LCEL 체인은 옛 API와 시그니처를 일부러 비슷하게 유지했다.

**옛날**:
```js
const result = await findPersona(description, googleGenAI);
```

**새것**:
```js
const result = await findPersona(description);
// googleGenAI 인자 사라짐 — gemini.mjs 내부에 모델 객체가 모듈 단위로 있음
```

이 작은 변화가 의미하는 건: **클라이언트(라우트 핸들러)는 LLM 구현을 더 이상 모른다**. 의존성 방향이 정리됐다.

---

## 6. 여기까지 정리 — Phase 1 한 그림

```
        ┌────────────────────────────────────────────────────────┐
        │  Express 핸들러 (index.mjs)                              │
        │                                                          │
        │   findPersona(description)                                │
        │        │                                                  │
        │        ▼                                                  │
        │   findPersonaChain.invoke(...)   ← LCEL 체인 (gemini.mjs) │
        │        │                                                  │
        │        ▼                                                  │
        │   ChatPromptTemplate → model.withStructuredOutput(Zod)   │
        │                                                          │
        │   generateAugmentedPrompt(...)                            │
        │        │                                                  │
        │        ▼                                                  │
        │   augmentPromptChain.invoke(...) ← LCEL 체인              │
        │        │                                                  │
        │        ▼                                                  │
        │   ChatPromptTemplate → model → JsonOutputParser → λ      │
        │                                                          │
        │   generateSong(body)                                      │
        │        │                                                  │
        │        ▼                                                  │
        │   generateSongRunnable.invoke(body) ← RunnableLambda     │
        │        │                                                  │
        │        ▼                                                  │
        │   axios.post('https://api.musicgpt.com/...')             │
        └────────────────────────────────────────────────────────┘
```

여기까지는 그냥 **"코드 정리"**다. 사용자 경험은 동일.

---

## 7. LangGraph — 왜 또 도입했나?

Phase 1의 LCEL 체인은 **선형 파이프라인**에 잘 맞다 (`A.pipe(B).pipe(C)`). 하지만 우리 흐름엔:

- 🔁 **루프**: MusicGPT 응답을 5초마다 폴링해서 완성될 때까지 기다림
- 🛑 **사람 확인**: augmentedPrompt를 실제로 MusicGPT에 보내기 전에 사용자가 OK/취소
- 🪨 **분기**: 사용자가 취소했으면 음악 생성을 안 함

이걸 LCEL로 짜면 결국 if/while로 둘러싸인 코드가 된다. 흐름이 코드 안에 숨는다.

LangGraph는 이걸 **그래프 자료구조**로 명시적으로 그려준다. 노드(node)와 엣지(edge)로.

> 직관적 비유: LCEL은 "함수 합성", LangGraph는 "상태 머신(state machine)".

---

## 8. LangGraph 핵심 개념 6가지

### 8-1. `StateGraph` — 그래프 본체

```js
const builder = new StateGraph(PipelineState)  // ← state 스키마 받음
  .addNode('이름', 함수)
  .addEdge('A', 'B')
  .addConditionalEdges('C', router함수, ['목적지1', 목적지2', END])
  ...

const graph = builder.compile({ checkpointer: ... });
// ↑ 컴파일하면 .invoke 가능한 Runnable이 나온다
```

`compile()` 결과도 **Runnable**이다. (그래서 LangChain 다른 부품들과 호환된다.)

### 8-2. `Annotation.Root({...})` — State 모양 선언

State란 "그래프가 실행 중에 들고 있는 데이터"다. 노드 사이를 흐르면서 누적된다.

```js
const PipelineState = Annotation.Root({
  description: Annotation(),     // 기본
  persona: Annotation(),
  pollAttempts: Annotation({     // reducer 지정
    reducer: (prev, next) => next ?? prev ?? 0,
    default: () => 0,
  }),
  ...
});
```

각 필드는 `Annotation()` 호출이다. 빈 괄호는 "기본 동작"을 의미한다:
- **기본 동작**: 노드가 그 필드를 반환하면 그냥 **덮어쓴다**.
- **reducer 지정**: 노드가 반환한 값과 기존 값을 어떻게 합칠지 직접 결정.

우리 코드에서 `pollAttempts`에 reducer를 준 이유: poll 시도 횟수는 누적이 중요한데, **덮어쓰기가 의도와 일치하므로** 사실 빈 `Annotation()`이어도 동작은 같다. 하지만 **명시적으로 reducer를 보여주는 게 학습 가치**가 있어서 일부러 작성했다. (만약 두 노드가 동시에 같은 필드를 쓴다면 reducer가 진가를 발휘한다.)

### 8-3. 노드 — `addNode(name, fn)`

```js
async function personaMatchNode(state) {
  // state는 현재 그래프 state 객체
  // 반환값은 "state를 어떻게 업데이트할지"의 부분 객체
  return {
    persona: 어떤페르소나,
    personaIndex: 2,
    recommendationMessage: '...',
  };
}

builder.addNode('personaMatch', personaMatchNode);
```

노드 함수는:
- **입력**: 현재 state 전체
- **출력**: state에 머지(merge)할 부분 객체 (각 필드는 그 필드의 reducer로 합쳐짐)

### 8-4. 엣지 — `addEdge(from, to)`

```js
builder.addEdge('A', 'B');       // A 끝나면 무조건 B
builder.addEdge(START, 'A');     // 그래프 시작은 A
builder.addEdge('Z', END);       // Z 끝나면 그래프 종료
```

`START`, `END`는 LangGraph에서 import하는 상수다.

### 8-5. 조건 엣지 — `addConditionalEdges(from, router, possibleTargets)`

분기/루프를 만드는 핵심.

```js
function pollDoneRouter(state) {
  if (state.status === 'done') return END;
  return 'pollStatus';   // ← 자기 자신으로 보내면 루프
}

builder.addConditionalEdges('pollStatus', pollDoneRouter, ['pollStatus', END]);
```

읽는 법: "`pollStatus` 노드가 끝나면 → `pollDoneRouter(state)`를 호출 → 반환값이 노드 이름이면 거기로, `END`면 종료. 가능한 목적지는 `['pollStatus', END]`."

이게 우리 그래프의 자기 자신으로 돌아가는 **self-loop**다. 폴링 루프가 그래프 다이어그램에 명시적으로 등장한다.

### 8-6. `interrupt()` + `MemorySaver` — HITL(사람 확인)

LangGraph의 진짜 매력적인 기능. 노드 함수 안에서 `interrupt(payload)`를 호출하면:

1. 그래프가 그 자리에 **멈춘다**.
2. 현재 state가 `MemorySaver`(=체크포인터)에 저장된다.
3. 첫 `graph.invoke()` 호출이 반환된다 (state는 부분 완성).
4. 외부에서 사용자에게 뭔가 물어본다.
5. 같은 `thread_id`로 `graph.invoke(new Command({ resume: 응답 }), config)`를 다시 호출.
6. **`interrupt()`의 반환값으로 그 응답이 들어가고**, 노드가 이어서 실행된다.

이게 가능한 이유는 LangGraph가 그래프 실행을 **체크포인트 기반**으로 관리하기 때문. MemorySaver는 in-memory 체크포인터(테스트/개발용)다. 프로덕션이면 SQLite/Postgres 체크포인터로 교체한다.

코드 예 (`graph.mjs` 라인 106~115):
```js
async function confirmGateNode(state) {
  const userInput = interrupt({
    question: '이 augmented prompt로 노래를 생성할까요?',
    augmentedPrompt: state.augmentedPrompt,
    persona: state.persona?.name,
  });
  return { userConfirmed: userInput === true || userInput === 'yes' };
}
```

이걸 깨우는 쪽 (`examples/run-graph.mjs` 라인 60):
```js
state = await graph.invoke(new Command({ resume: resumeWith }), threadConfig);
//                          └────────── interrupt()의 반환값으로 들어감
```

---

## 9. `graph.mjs` 라인별 해설

```js
// ───── import 블록 (라인 1-5) ─────
import {
  StateGraph,    // 그래프 빌더 클래스
  Annotation,    // State 스키마 선언용
  START, END,    // 특수 상수 (시작/끝 노드를 가리킴)
  interrupt,     // 노드 안에서 HITL 일시정지
  MemorySaver,   // in-memory 체크포인터
} from '@langchain/langgraph';
// ↓ Phase 1에서 만든 LCEL 체인들을 그대로 import
import { personaPickerChain, recommendMessageChain, augmentPromptChain } from './gemini.mjs';
// ↓ Phase 1에서 만든 RunnableLambda들
import { generateSongRunnable, getSongStatusRunnable } from './music-gpt.mjs';
import personas from './personas.mjs';
import { setTimeout as delay } from 'node:timers/promises';  // 5초 대기용
```

```js
// ───── State 스키마 (라인 33-60) ─────
const PipelineState = Annotation.Root({
  description: Annotation(),     // 사용자 자기소개 (입력)
  userMessage: Annotation(),     // 노래로 만들고 싶은 이야기 (입력)

  persona: Annotation(),          // personaMatch가 채움
  personaIndex: Annotation(),
  recommendationMessage: Annotation(),

  augmentedPrompt: Annotation(),  // promptAugment가 채움 ({ answer, prompt, genre })

  jobId: Annotation(),            // musicGptCall이 채움
  eta: Annotation(),

  pollAttempts: Annotation({      // ← 유일하게 reducer 명시한 필드
    reducer: (prev, next) => next ?? prev ?? 0,
    default: () => 0,
  }),
  status: Annotation(),           // 'processing' | 'done' | 'failed'
  result: Annotation(),           // 최종 노래 정보

  userConfirmed: Annotation(),    // confirmGate가 HITL resume 후 채움
});
```

```js
// ───── 노드 1: personaMatch (Multi-Agent) ─────
async function personaMatchNode(state) {
  // Agent 1: 인덱스 결정 (Zod로 { personaIndex } 강제)
  const picked = await personaPickerChain.invoke({
    description: state.description,
    personas: JSON.stringify(personas, null, 2),
  });
  const persona = personas[picked.personaIndex];

  // Agent 2: 위에서 고른 persona를 가지고 추천 메시지 작성
  const recommended = await recommendMessageChain.invoke({
    description: state.description,
    persona: JSON.stringify(persona),
  });

  return {
    personaIndex: picked.personaIndex,
    persona,
    recommendationMessage: recommended.recommendationMessage,
  };
}
```

**왜 두 호출로 쪼개나?** 책임 분리. picker는 "선택"만, recommender는 "글짓기"만. 각 프롬프트가 짧고 명확. 추후 picker만 더 싼 모델로 교체 가능.

```js
// ───── 노드 2: promptAugment (Phase 1 체인 재사용) ─────
async function promptAugmentNode(state) {
  const result = await augmentPromptChain.invoke({
    prompt: state.userMessage,
    persona: state.persona?.persona ?? '',
    arts_persona: state.persona?.arts_persona ?? '',
  });
  return { augmentedPrompt: result };
}
```

`augmentPromptChain`은 Phase 1에서 만든 LCEL 4단계 파이프. **그래프 노드에서 그대로 호출**. 이게 Phase 1의 추상화가 빛나는 지점.

```js
// ───── 노드 3: confirmGate (HITL) ─────
async function confirmGateNode(state) {
  const userInput = interrupt({
    question: '이 augmented prompt로 노래를 생성할까요?',
    augmentedPrompt: state.augmentedPrompt,
    persona: state.persona?.name,
  });
  return { userConfirmed: userInput === true || userInput === 'yes' };
}
```

- 첫 실행 시 `interrupt(...)`가 그래프를 멈춤. 첫 `graph.invoke()`가 반환됨.
- 외부에서 사용자 응답을 받아 `Command({ resume: true })`로 재개.
- 재개 시 `interrupt()`의 반환값이 `userInput`. 그걸 boolean으로 변환해서 state에 넣음.

```js
// ───── 노드 4: musicGptCall (Tool 호출) ─────
async function musicGptCallNode(state) {
  if (state.userConfirmed === false) {
    return { status: 'failed', result: { reason: 'user declined' } };
  }
  if (process.env.GRAPH_DRY_RUN === '1') {
    return { jobId: 'dry-' + Date.now(), eta: 1, status: 'processing' };
  }
  const result = await generateSongRunnable.invoke({
    prompt: state.augmentedPrompt?.prompt ?? '',
    music_style: state.augmentedPrompt?.genre ?? '',
  });
  return { jobId: result?.task_id, eta: result?.eta, status: 'processing' };
}
```

- 사용자가 거부했으면 즉시 실패 상태로 종료.
- `--dry` 옵션이 켜져 있으면 mock 응답 (실제 MusicGPT 호출 비용 회피).
- 정상 흐름: Phase 1의 `generateSongRunnable`을 호출.

```js
// ───── 노드 5: pollStatus (self-loop) ─────
async function pollStatusNode(state) {
  const attempt = (state.pollAttempts ?? 0) + 1;
  await delay(POLL_INTERVAL_MS);   // 5초 sleep

  if (process.env.GRAPH_DRY_RUN === '1') {
    if (attempt >= 2) return { pollAttempts: attempt, status: 'done', result: {...} };
    return { pollAttempts: attempt, status: 'processing' };
  }

  const raw = await getSongStatusRunnable.invoke(state.jobId);
  const c = raw?.conversion;
  const completed = (c?.status === 'COMPLETED' || c?.status === 'GENERATION_COMPLETED') && ...;

  if (completed) return { pollAttempts: attempt, status: 'done', result: {...} };
  return { pollAttempts: attempt, status: 'processing' };
}
```

이 노드는 **자기 자신에게 돌아오는 것이 정상 동작**이다. 매번 `pollAttempts`를 +1 해서 반환. 조건 분기가 종료를 결정.

```js
// ───── 라우터 (조건 분기 함수) ─────
function pollDoneRouter(state) {
  if (state.status === 'done' || state.status === 'failed') return END;
  if ((state.pollAttempts ?? 0) >= MAX_POLL_ATTEMPTS) return END;
  return 'pollStatus';
}
```

읽는 법: "state 보고 다음 어디로 갈지 결정. 완료/실패면 END, 60번 넘으면 END, 아니면 자기 자신."

```js
// ───── 그래프 빌더 (라인 202-218) ─────
export function buildPipelineGraph() {
  const builder = new StateGraph(PipelineState)
    .addNode('personaMatch', personaMatchNode)
    .addNode('promptAugment', promptAugmentNode)
    .addNode('confirmGate', confirmGateNode)
    .addNode('musicGptCall', musicGptCallNode)
    .addNode('pollStatus', pollStatusNode)
    .addEdge(START, 'personaMatch')        // START → personaMatch
    .addEdge('personaMatch', 'promptAugment')
    .addEdge('promptAugment', 'confirmGate')
    .addEdge('confirmGate', 'musicGptCall')
    .addEdge('musicGptCall', 'pollStatus')
    .addConditionalEdges(
      'pollStatus',
      pollDoneRouter,
      ['pollStatus', END]   // ← 가능한 목적지 명시 (성능 최적화 힌트)
    );

  return builder.compile({ checkpointer: new MemorySaver() });
}
```

`MemorySaver`가 필수인 이유: `interrupt()`로 멈췄을 때 state를 어딘가 저장해 둬야 나중에 resume할 수 있다. 메모리에 저장하는 가장 단순한 체크포인터가 `MemorySaver`.

---

## 10. `examples/run-graph.mjs` 라인별 해설

이 CLI 데모는 **그래프를 어떻게 호출하는지** 보여준다.

```js
// 라인 18: --dry 모드면 환경변수 세팅
const argv = new Set(process.argv.slice(2));
if (argv.has('--dry')) {
  process.env.GRAPH_DRY_RUN = '1';   // graph.mjs 안의 노드가 이걸 본다
}
```

```js
// 라인 35-36: 사용자 입력 받기
const description = await ask(rl, '당신을 한 줄로 소개해주세요...');
const userMessage = await ask(rl, '\n노래로 만들고 싶은 이야기/감정...');
```

```js
// 라인 38-39: 그래프 빌드 + thread_id 부여
const graph = buildPipelineGraph();
const threadConfig = { configurable: { thread_id: 'demo-' + Date.now() } };
```

**`thread_id`가 왜 필요한가?** 체크포인터(MemorySaver)가 "어느 실행"을 저장하는지 구분해야 한다. 같은 그래프를 동시에 여러 사용자가 돌릴 수 있으니까. 하나의 사용자 세션 = 하나의 thread_id. 우리는 데모니까 timestamp로 유니크하게.

```js
// 라인 44: 첫 invoke — interrupt까지 진행
let state = await graph.invoke({ description, userMessage }, threadConfig);
//                              ↑ 초기 input             ↑ thread_id 포함된 config
```

이 호출은 `confirmGate`의 `interrupt()`에서 멈춘다. 그래서 반환되는 `state`는 **아직 미완성**이다 (jobId 등이 없음).

```js
// 라인 47-48: 인터럽트가 걸려있는지 확인
let snapshot = await graph.getState(threadConfig);
const hasInterrupt = snapshot.tasks?.some((t) => t.interrupts && t.interrupts.length > 0) ?? false;
```

`graph.getState(threadConfig)`는 체크포인터에 저장된 현재 state + 메타 정보(어떤 노드에서 멈췄는지 등)를 반환. `snapshot.tasks`에 pending interrupt가 있으면 사람이 응답할 차례.

```js
// 라인 50-60: 사용자에게 보여주고 응답 받기
if (hasInterrupt) {
  const interruptPayload = snapshot.tasks.flatMap((t) => t.interrupts ?? []).map((i) => i.value)[0];
  console.log('페르소나:', interruptPayload?.persona);
  console.log('augmentedPrompt:', interruptPayload?.augmentedPrompt);

  const yes = (await ask(rl, '이대로 노래를 생성할까요? (y/N): ')).toLowerCase();
  const resumeWith = yes === 'y' || yes === 'yes';

  // 같은 thread_id로 재개
  state = await graph.invoke(new Command({ resume: resumeWith }), threadConfig);
  //                          ↑ interrupt()의 반환값이 이 resume 값이 된다
}
```

이 두 번째 `invoke` 호출은 `confirmGate` 이후를 계속 실행한다. `pollStatus`까지 돌아 완성된 state를 반환.

```js
// 라인 65-71: 최종 결과 출력
console.log('status:', state.status);
console.log('persona:', state.persona?.name);
console.log('result:', state.result);
```

이게 전체 시퀀스. **API 호출 → interrupt → 사용자 응답 → 재개 → 종료** 패턴이 깔끔하게 보인다.

---

## 11. 자주 헷갈리는 것들 FAQ

### Q. `findPersonaChain`과 `personaPickerChain`이 둘 다 있는데, 안 겹치나?

- `findPersonaChain` = **단일 호출**로 인덱스 + 추천 메시지 둘 다 반환. **Express 라우트가 사용**.
- `personaPickerChain` + `recommendMessageChain` = 같은 일을 **두 LLM 호출로 분리**. **LangGraph `personaMatch` 노드가 사용**.

목적: Express 호환성을 유지하면서도 LangGraph 쪽에선 Multi-Agent 패턴을 시연. 두 surface가 같은 모듈에서 공존한다는 게 LCEL 추상화의 장점이기도 하다.

### Q. `Annotation()` 빈 괄호와 reducer 있는 거 차이는?

- 빈 `Annotation()`: 기본 reducer. 새 값으로 **덮어쓴다**.
- `Annotation({ reducer, default })`: 사용자 정의 reducer. 두 값을 어떻게 합칠지 직접 결정.

우리는 단순한 흐름이라 사실상 둘 다 같은 동작이지만, `pollAttempts`에 reducer를 명시적으로 적은 건 **"이런 식으로 합쳐진다"를 코드에서 보이게** 하려는 의도였다.

### Q. `withStructuredOutput`이랑 `JsonOutputParser`는 둘 다 JSON 받는 거 아닌가? 차이는?

| | `withStructuredOutput(zodSchema)` | `new JsonOutputParser()` |
|---|---|---|
| 위치 | model을 한 번 감싸서 반환 (provider 기능 활용) | LCEL 체인의 한 단계로 추가 |
| 스키마 | 강제됨 (Zod) | 없음 (그냥 JSON 모양이면 OK) |
| 검증 | Zod로 추가 검증 | 없음 |
| 언제 | 정확한 모양을 원할 때 (인덱스 등) | 모양이 유연해도 되는 응답 |

우리는 `findPersona`엔 전자, `generateAugmentedPrompt`엔 후자를 썼다. 후자는 모델이 어디까지 어떻게 적었는지에 따라 응답 모양이 약간 들쭉날쭉할 수 있어서 더 관대한 파서가 적합.

### Q. `MemorySaver` 없이도 그래프가 동작하나?

동작하지만 `interrupt()` 사용 불가. interrupt가 state를 저장해 둬야 resume할 수 있는데, 저장소가 없으면 멈출 수 없다.
HITL을 안 쓰는 그래프면 checkpointer 생략 가능.

### Q. `--dry` 모드는 LLM도 mock하나?

**아니다.** Gemini는 진짜 호출한다(`GEMINI_API_KEY` 필요). MusicGPT만 mock. 이유는 LLM이 흐름의 핵심이고 빠르고 싼 반면, MusicGPT는 분당 비용이 들고 응답까지 분 단위로 걸리기 때문.

### Q. 면접에서 "그래서 Phase 2를 Express에 통합 안 했네요?"라고 물으면?

정직하게:
> "현재는 데모 CLI(`examples/run-graph.mjs`)에서만 시연합니다. 실서비스의 `/api/*` 엔드포인트는
> Phase 1의 LCEL 체인을 직접 호출합니다.
>
> Express에 그래프를 통합하려면 SSE나 WebSocket으로 HITL interrupt를 클라이언트와 주고받아야 하는데,
> 이번 작업의 범위는 거기까지 가지 않았습니다. 그래프 구조 자체(`graph.mjs`)는 모듈로 분리돼 있어서
> 통합 시 진입점만 새로 만들면 됩니다."

이게 진짜 honesty다. 과장하지 말 것.

---

## 12. 면접 답변이 코드 어디서 나오는지 매핑

`docs/MIGRATION.md`의 1분 답변 스크립트 4개와 이 가이드/실제 코드의 대응:

| 질문 | 답의 핵심 | 보여줄 코드 |
|---|---|---|
| Q1. "왜 LangChain?" | JSON 파싱 안정화 + 구조화 출력 + 다단계 확장성 | `gemini.mjs`의 `.pipe(...)` 체인 4단계 |
| Q2. "Multi-Agent 어디?" | personaPickerChain → recommendMessageChain | `gemini.mjs` 라인 134~191 + `graph.mjs`의 `personaMatchNode` |
| Q3. "HITL 어디에 어떻게?" | confirmGate에서 `interrupt()` + `Command({resume})` | `graph.mjs` 라인 106~115 + `examples/run-graph.mjs` 라인 60 |
| Q4. "조건 분기/루프?" | `addConditionalEdges` + `pollDoneRouter` | `graph.mjs` 라인 192~214 |

각 코드 위치를 외워두면 면접에서 코딩 화면 공유할 때 바로 그 줄로 갈 수 있다.

---

## 끝.

여기까지 읽었다면 우리 코드의 모든 라인을 이해할 수 있을 것이다.

다음에 만질 때 좋은 출발점:
- `gemini.mjs`에 새 체인 추가하기 (예: 가사 생성 chain)
- `graph.mjs`에 새 노드 추가하기 (예: 노래 생성 후 평가 노드)
- `examples/run-graph.mjs`처럼 Express에 그래프 통합하기 (`/api/run-pipeline`)
