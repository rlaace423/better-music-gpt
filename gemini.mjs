import { Type } from '@google/genai';

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

export async function generateAugmentedPrompt(prompt, persona, arts_persona, googleGenAI) {
  // const response = await googleGenAI.models.generateContent({
  //   model: 'gemini-2.0-flash',
  //   contents: prompt,
  //   config: {
  //     systemInstruction: `너는 음악 생성 AI에 전달할 prompt의 내용을 augmentation 하는 AI야. prompt와 persona를 참고하여 장르를 1개 결정해줘야 해. 대답은 다음과 같은 JSON 형식으로 해줘. { answer: "여기에 너의 대답이 한국어로 들어가는거야. music 생성을 위한 prompt 말투가 아닌, 이러이러하셨군요, 그렇다면 이러이러한 음악을 만들어드릴게요 같은 느낌으로 넣어줘.", prompt: "여기엔 music 생성을 위한 상세한 prompt가 영어로 들어가야 해. This prompt MUST be between 180 and 200 characters. This is a very strict rule.", genre: "여기에 장르 이름이 영어로 들어가야해" }`,
  //   },
  // });
  // console.log(response.text);
  // return parseResponseText(response.text);

  const response = await googleGenAI.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: `<prompt>${prompt}</prompt><persona>${persona}</persona><arts_persona>${arts_persona}</arts_persona>`,
    config: {
      systemInstruction: `너는 음악 생성 AI에 전달할 prompt의 내용을 augmentation 하는 AI야. prompt, persona, arts_persona를 참고하여 장르를 1개 결정해줘야 해. 대답은 다음과 같은 JSON 형식으로 해줘. { answer: "여기에 너의 대답이 한국어로 들어가는거야. persona를 참고해. music 생성을 위한 prompt 말투가 아닌, 어떠한 누구누구 님, 이러이러하셨군요, 그렇다면 이러이러한 음악을 만들어드릴게요 같은 느낌으로 넣어줘.", prompt: "여기엔 music 생성을 위한 상세한 prompt가 영어로 들어가야 해. arts_persona를 참고해. This prompt MUST be between 180 and 200 characters. This is a very strict rule.", genre: "여기에 장르 이름이 영어로 들어가야해" }`,
    },
  });
  console.log(response.text);
  return parseResponseText(response.text);

  // const response = await googleGenAI.models.generateContent({
  //   model: 'gemini-1.5-flash', // JSON 모드는 최신 모델에서 더 잘 작동합니다. 1.5 Flash 추천.
  //   contents: [{ role: 'user', parts: [{ text: prompt }] }],
  //
  //   config: {
  //     // systemInstruction은 AI의 역할만 간단히 정의합니다.
  //     // systemInstruction: `You are an expert AI that augments a user's input into a detailed prompt and a genre for a music generation AI.`,
  //     responseMimeType: 'application/json',
  //     responseSchema: {
  //       type: Type.OBJECT,
  //       properties: {
  //         answer: {
  //           type: Type.STRING,
  //           description:
  //             "Your response in Korean, addressing the user as if you were the music generation AI. Use a conversational tone, acknowledging their request and explaining what kind of music you'll create.",
  //         },
  //         prompt: {
  //           type: Type.STRING,
  //           minLength: 180,
  //           maxLength: 200,
  //           description:
  //             'The augmented prompt in English for music generation. This MUST be between 180 and 200 characters. This is a very strict rule.',
  //         },
  //         genre: {
  //           type: Type.STRING,
  //           description: '생성될 음악의 장르 이름. 영어로 작성되어야 합니다. (e.g., Hard Rock, Ballad, Jazz)',
  //         },
  //       },
  //       required: ['answer', 'prompt', 'genre'],
  //     },
  //   },
  // });
  //
  // // 결과 확인
  // const resultJson = JSON.parse(response.candidates[0].content.parts[0].text);
  // console.log(resultJson);

  //   const response = await googleGenAI.models.generateContent({
  //     model: 'gemini-2.0-flash',
  //     contents: `
  //     You are an AI tasked with augmenting prompts for a music generation AI. Your goal is to enhance the original prompt by incorporating elements from a given persona, select an appropriate genre, and format the response in a specific JSON structure.
  //
  // First, you will be given information about a persona. Read this carefully as it will inform how you augment the prompt:
  //
  // <persona>They appreciate the gritty realism of Texas artist David Adickes' sculptures and the soulful melodies of Tejano musician Selena, often visiting the San Antonio Museum of Art and listening to her music while cooking.</persona>
  //
  // Next, here is the original prompt you will be working with:
  //
  // <original_prompt>
  //
  // ${prompt}
  //
  // </original_prompt>
  //
  // Your task is to augment this prompt by incorporating elements from the given persona. Consider the persona's musical preferences, cultural background, and personal experiences when crafting your augmented prompt. The augmented prompt should be more detailed and personalized, while still maintaining the essence of the original request.
  //
  // Your response should be in the following JSON format:
  //
  // {
  //
  // "answer": "Your response in Korean, addressing the user as if you were the music generation AI. Use a conversational tone, acknowledging their request and explaining what kind of music you'll create.",
  //
  // "prompt": "The augmented prompt in English for music generation. This MUST be between 180 and 200 characters. This is a very strict rule.",
  //
  // "genre": "The selected genre name in English"
  //
  // }
  //
  // When selecting the genre, choose one that best fits the augmented prompt and the persona's preferences. Ensure that the augmented prompt in English is between 180 and 200 characters long, as this is a strict requirement.
  //
  // Remember to maintain a friendly and engaging tone in the Korean answer, as if you were directly addressing the user about the music you're about to create based on their preferences and background.
  //     `,
  //     // config: {
  //     //   systemInstruction: `너는 음악 생성 AI에 전달할 prompt의 내용을 augmentation 하는 AI야. prompt를 보고 장르를 1개 결정해줘야 해. 대답은 다음과 같은 JSON 형식으로 해줘. { answer: "여기에 너의 대답이 한국어로 들어가는거야. music 생성을 위한 prompt 말투가 아닌, 이러이러하셨군요, 그렇다면 이러이러한 음악을 만들어드릴게요 같은 느낌으로 넣어줘.", prompt: "여기엔 music 생성을 위한 상세한 prompt가 영어로 들어가야 해. This prompt MUST be between 180 and 200 characters. This is a very strict rule.", genre: "여기에 장르 이름이 영어로 들어가야해" }`,
  //     // },
  //   });
  //   console.log(response.text);
  //   return parseResponseText(response.text);
}
