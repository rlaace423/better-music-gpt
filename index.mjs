import express from 'express';
import { GoogleGenAI } from '@google/genai';
import config from './config.mjs';
import { generateAugmentedPrompt } from './gemini.mjs';
import errorHandler from './error-handler.mjs';
import { generateSong, getSongStatus } from './music-gpt.mjs';

const API_PREFIX = 'api';

const app = express();
const googleGenAI = new GoogleGenAI({ apiKey: config.geminiApiKey });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.post(`/${API_PREFIX}/generate-prompt`, async (req, res) => {
  const prompt = req.body?.prompt;

  if (!prompt || prompt.length === 0) {
    throw new Error('내용을 입력헤주세요!');
  }
  const result = await generateAugmentedPrompt(prompt, googleGenAI);

  return res.status(200).json({
    status: 'success',
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
