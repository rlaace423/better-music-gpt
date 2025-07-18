import express from 'express';
import { GoogleGenAI } from '@google/genai';
import config from './config.mjs';
import personas from './personas.mjs';
import { findPersona, generateAugmentedPrompt } from './gemini.mjs';
import errorHandler from './error-handler.mjs';
import { generateSong, getSongStatus } from './music-gpt.mjs';

const API_PREFIX = 'api';

const app = express();
const googleGenAI = new GoogleGenAI({ apiKey: config.geminiApiKey });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get(`/${API_PREFIX}/personas`, (req, res) => {
  return res.json(personas);
});

app.post(`/${API_PREFIX}/find-persona`, async (req, res) => {
  const { description } = req.body;

  if (!description || description.length === 0) {
    throw new Error('description과 personas 배열이 필요합니다.');
  }
  const result = await findPersona(description, googleGenAI);

  return res.json({
    personaIndex: result.personaIndex,
    persona: personas[result.personaIndex],
    recommendationMessage: result.recommendationMessage,
  });
});

app.post(`/${API_PREFIX}/generate-prompt`, async (req, res) => {
  const prompt = req.body?.prompt;
  const persona = req.body?.persona;
  const arts_persona = req.body?.arts_persona;

  if (!prompt || prompt.length === 0) {
    throw new Error('내용을 입력헤주세요!');
  }
  const result = await generateAugmentedPrompt(prompt, persona, arts_persona, googleGenAI);

  return res.status(200).json({
    status: 'success',
    originalPrompt: prompt,
    ...result,
  });
});

app.post(`/${API_PREFIX}/generate-song`, async (req, res) => {
  const body = {
    prompt: req.body?.prompt || '',
    music_style: req.body?.music_style || '',
  };

  const result = await generateSong(body);

  return res.status(200).json({
    status: 'success',
    ...result,
  });
});

app.get(`/${API_PREFIX}/get-song-status`, async (req, res) => {
  const taskId = req.query?.task_id;

  if (!taskId || taskId.length === 0) {
    throw new Error('task_id에 대한 노래가 존재하지 않습니다!');
  }
  const result = await getSongStatus(taskId);

  return res.status(200).json({
    status: 'success',
    ...result,
  });
});

app.use(errorHandler);

app.listen(process.env.PORT, '0.0.0.0', async () => {
  console.log(`Better-Music-GPT Listening on port ${config.port}`);
});
