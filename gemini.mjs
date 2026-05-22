import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { RunnableLambda } from '@langchain/core/runnables';
import { z } from 'zod';
import personas from './personas.mjs';
import config from './config.mjs';

/*
 * LangChain.js (LCEL) migration.
 *
 * 두 개의 LLM 파이프라인을 LCEL 체인으로 정의한다:
 *
 *   findPersonaChain      = ChatPromptTemplate | model.withStructuredOutput(Zod)
 *   augmentPromptChain    = ChatPromptTemplate | model | JsonOutputParser | RunnableLambda(safety)
 *
 * - withStructuredOutput: 신뢰 가능한 구조화 출력 (이전엔 responseSchema 사용)
 * - JsonOutputParser + RunnableLambda: 이전엔 직접 substring으로 JSON 추출하던 안전망을
 *   정식 파서 + 후처리 람다로 승격. prompt 200자 제한도 람다에서 일관 적용.
 */

const model = new ChatGoogleGenerativeAI({
  apiKey: config.geminiApiKey,
  model: 'gemini-2.5-flash',
});

// ------------------------------------------------------------------
// 1. findPersona — 구조화 출력 (Zod schema)
// ------------------------------------------------------------------

const PersonaPickSchema = z.object({
  personaIndex: z
    .number()
    .int()
    .min(0)
    .max(personas.length - 1)
    .describe('The 0-based index of the most suitable persona from the provided list.'),
  recommendationMessage: z
    .string()
    .describe(
      'A personalized recommendation message for the user in KOREAN. ' +
        "It MUST wrap the chosen persona's name with single asterisks. " +
        "Example: '...페르소나인 *Quintin*을 추천합니다.'",
    ),
});

const findPersonaPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    'You are a helpful AI assistant that matches a user to a persona. ' +
      'Choose the ONE most suitable persona from the provided list, and write a ' +
      'personalized recommendation message in Korean explaining why.',
  ],
  [
    'human',
    `**User's Self-Description:**
"{description}"

**Persona List (JSON):**
{personas}`,
  ],
]);

const findPersonaChain = findPersonaPrompt.pipe(model.withStructuredOutput(PersonaPickSchema));

export async function findPersona(description) {
  try {
    const result = await findPersonaChain.invoke({
      description,
      personas: JSON.stringify(personas, null, 2),
    });

    // 방어적 검증 (스키마가 막아주긴 하지만 한 번 더)
    const safeIndex =
      typeof result?.personaIndex === 'number' && result.personaIndex >= 0 && result.personaIndex < personas.length
        ? result.personaIndex
        : 0;
    const safeMessage = typeof result?.recommendationMessage === 'string' ? result.recommendationMessage.trim() : '';

    return { personaIndex: safeIndex, recommendationMessage: safeMessage };
  } catch (e) {
    console.error('[findPersona] chain failed:', e);
    return { personaIndex: 0, recommendationMessage: '' };
  }
}

// ------------------------------------------------------------------
// 2. generateAugmentedPrompt — JSON 파서 + safety lambda
// ------------------------------------------------------------------

const augmentPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `너는 음악 생성 AI에 전달할 prompt의 내용을 augmentation 하는 AI야. ` +
      `prompt, persona, arts_persona를 참고하여 장르를 1개 결정해줘야 해. ` +
      `오직 JSON 형식으로만 응답해 (다른 텍스트 금지). 형식: ` +
      `{{ "answer": "한국어 대답. persona 참고. music 생성 prompt 말투 말고, ` +
      `'이러이러한 분이시군요, 그렇다면 이러한 음악을 만들어드릴게요' 식.", ` +
      `"prompt": "music 생성용 영어 prompt — arts_persona 참고. ` +
      `MUST be between 180 and 200 characters. Very strict rule.", ` +
      `"genre": "장르 이름 (영어)" }}`,
  ],
  ['human', '<prompt>{prompt}</prompt><persona>{persona}</persona><arts_persona>{arts_persona}</arts_persona>'],
]);

// 200자 초과 시 자르는 후처리(원본 동작 보존). LCEL 체인 마지막 단계.
const enforcePromptLimit = RunnableLambda.from((parsed) => {
  if (parsed && typeof parsed.prompt === 'string' && parsed.prompt.length > 200) {
    return { ...parsed, prompt: parsed.prompt.slice(0, 200) };
  }
  return parsed ?? { answer: '', prompt: '', genre: '' };
});

const augmentPromptChain = augmentPrompt.pipe(model).pipe(new JsonOutputParser()).pipe(enforcePromptLimit);

export async function generateAugmentedPrompt(prompt, persona, arts_persona) {
  return augmentPromptChain.invoke({ prompt, persona, arts_persona });
}

// 체인 자체도 export — Phase 2(LangGraph)에서 노드로 직접 쓸 수 있도록.
export { findPersonaChain, augmentPromptChain };

// ------------------------------------------------------------------
// 3. Multi-Agent split — findPersona를 두 개의 LLM Agent로 분리
//    Phase 2 LangGraph의 personaMatch 노드가 두 agent를 순차 호출한다.
//
//    pickerAgent       : description + 페르소나 목록 → personaIndex 선택만
//    recommenderAgent  : description + 선택된 persona → 한국어 추천 메시지
//
//    하나의 LLM 호출로 둘 다 받던 것을 책임 단위로 쪼개서
//    Multi-Agent 오케스트레이션을 명시적으로 만든다.
// ------------------------------------------------------------------

const PersonaIndexSchema = z.object({
  personaIndex: z
    .number()
    .int()
    .min(0)
    .max(personas.length - 1)
    .describe('The 0-based index of the most suitable persona from the provided list.'),
});

const pickerPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    'You select the single most suitable persona for a user. ' +
      'Output only the index. Do not include any commentary.',
  ],
  [
    'human',
    `User's self-description:
"{description}"

Persona list (JSON):
{personas}

Pick exactly one persona (by 0-based index).`,
  ],
]);

export const personaPickerChain = pickerPrompt.pipe(model.withStructuredOutput(PersonaIndexSchema));

const RecommendationSchema = z.object({
  recommendationMessage: z
    .string()
    .describe(
      'A personalized recommendation message in KOREAN explaining why the given persona suits the user. ' +
        "Wrap the persona's name with single asterisks (e.g. '*Quintin*').",
    ),
});

const recommenderPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    'You write a short, warm recommendation message in KOREAN, ' +
      'explaining why a chosen persona suits the user. ' +
      "Always wrap the persona's name in single asterisks (e.g., *Quintin*).",
  ],
  [
    'human',
    `User's self-description:
"{description}"

Chosen persona (JSON):
{persona}

Write the Korean recommendation message.`,
  ],
]);

export const recommendMessageChain = recommenderPrompt.pipe(model.withStructuredOutput(RecommendationSchema));
