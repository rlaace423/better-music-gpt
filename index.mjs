import express from 'express';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import config from './config.mjs';

const app = express();
const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.listen(process.env.PORT, async () => {
  console.log(`Listening on port ${config.port}`);
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: "너무 화가나는 일이 있었어. 내 마음을 표현할 빡센 노래가 필요해",
    config: {
      systemInstruction: "너는 음악 생성 AI에 전달할 prompt의 내용을 augmentation 하는 AI야. prompt를 보고 장르를 1개 결정해줘야 해. 대답은 다음과 같은 JSON 형식으로 해줘. { answer: [여기에 너의 대답이 한국어로 들어가는거야. music 생성을 위한 prompt 말투가 아닌, 이러이러하셨군요, 그렇다면 이러이러한 음악을 만들어드릴게요 같은 느낌으로 넣어줘.], prompt: [여기엔 music 생성을 위한 prompt가 영어로 들어가야 해], genre: [여기에 장르 이름이 영어로 들어가야해] }",
    },
  });
  console.log(response.text);
});
