import { Type } from '@google/genai';
import personas from './personas.mjs';

function parseResponseText(response) {
  if (!response || typeof response !== 'string') {
    return '';
  }

  const firstBraceIndex = response.indexOf('{');
  const lastBraceIndex = response.lastIndexOf('}');

  if (firstBraceIndex > -1 && lastBraceIndex > -1 && lastBraceIndex > firstBraceIndex) {
    const jsonString = response.slice(firstBraceIndex, lastBraceIndex + 1);
    try {
      const parsed = JSON.parse(jsonString);
      if (parsed?.prompt.length > 200) {
        parsed.prompt = parsed.prompt.slice(0, 200);
      }
      return parsed;
    } catch (error) {
      return '';
    }
  } else {
    return '';
  }
}

export async function findPersona(description, googleGenAI) {
  const result = { personaIndex: 0, recommendationMessage: '' };

  try {
    const prompt = `
      Based on the user's self-description, your tasks are:
      1. Choose the ONE most suitable persona from the provided list.
      2. Write a personalized recommendation message in KOREAN. The message should explain why the chosen persona is a good match for the user.
      
      You MUST respond in the JSON format defined by the provided schema.

      **User's Self-Description:**
      "${description}"

      **Persona List (JSON):**
      ${JSON.stringify(personas, null, 2)}
    `;

    const response = await googleGenAI.models.generateContent({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: `You are a helpful AI assistant that matches a user to a persona.`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            personaIndex: {
              type: Type.NUMBER,
              description: 'The index of the most suitable persona from the provided list (0-based).',
            },
            recommendationMessage: {
              type: Type.STRING,
              description:
                "A personalized recommendation message for the user, written in Korean. It MUST wrap the chosen persona's name with single asterisks. For example: '...페르소나인 *Quintin*을 추천합니다.'",
            },
          },
          required: ['personaIndex', 'recommendationMessage'],
        },
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    console.log(response.text);
    const resultJson = JSON.parse(response.candidates[0].content.parts[0].text);
    const { personaIndex, recommendationMessage } = resultJson;
    // const index = parseInt(response.text.trim().match(/\d+/)[0], 10);

    if (typeof personaIndex !== 'number' || personaIndex < 0 || personaIndex >= personas.length) {
      console.error('AI가 유효한 인덱스를 반환하지 않았습니다.');
      result.personaIndex = 0;
    } else {
      result.personaIndex = personaIndex;
    }

    if (typeof recommendationMessage !== 'string' || recommendationMessage.trim().length === 0) {
      console.error('AI가 유효한 설명을 반환하지 않았습니다.');
    } else {
      result.recommendationMessage = recommendationMessage.trim();
    }
  } catch (e) {
    console.error(e);
  }
  return result;
}

export async function generateAugmentedPrompt(prompt, persona, arts_persona, googleGenAI) {
  const response = await googleGenAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `<prompt>${prompt}</prompt><persona>${persona}</persona><arts_persona>${arts_persona}</arts_persona>`,
    config: {
      systemInstruction: `너는 음악 생성 AI에 전달할 prompt의 내용을 augmentation 하는 AI야. prompt, persona, arts_persona를 참고하여 장르를 1개 결정해줘야 해. 대답은 다음과 같은 JSON 형식으로 해줘. { answer: "여기에 너의 대답이 한국어로 들어가는거야. persona를 참고해. music 생성을 위한 prompt 말투가 아닌, 어떠한 누구누구 님, 이러이러하셨군요, 그렇다면 이러이러한 음악을 만들어드릴게요 같은 느낌으로 넣어줘.", prompt: "여기엔 music 생성을 위한 상세한 prompt가 영어로 들어가야 해. arts_persona를 참고해. This prompt MUST be between 180 and 200 characters. This is a very strict rule.", genre: "여기에 장르 이름이 영어로 들어가야해" }`,
    },
  });
  console.log(response.text);
  return parseResponseText(response.text);
}
