function parseResponseText(response) {
  if (!response || typeof response !== 'string') {
    return "";
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
      return "";
    }
  } else {
    return "";
  }
}

export async function generateAugmentedPrompt(prompt, googleGenAI) {
  const response = await googleGenAI.models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
    config: {
      systemInstruction: `너는 음악 생성 AI에 전달할 prompt의 내용을 augmentation 하는 AI야. prompt를 보고 장르를 1개 결정해줘야 해. 대답은 다음과 같은 JSON 형식으로 해줘. { answer: "여기에 너의 대답이 한국어로 들어가는거야. music 생성을 위한 prompt 말투가 아닌, 이러이러하셨군요, 그렇다면 이러이러한 음악을 만들어드릴게요 같은 느낌으로 넣어줘.", prompt: "여기엔 music 생성을 위한 상세한 prompt가 영어로 들어가야 해. This prompt MUST be between 180 and 200 characters. This is a very strict rule.", genre: "여기에 장르 이름이 영어로 들어가야해" }`,
    },
  });
  console.log(response.text);
  return parseResponseText(response.text);
}
