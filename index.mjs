import express from 'express';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import config from './config.mjs';
import { generateAugmentedPrompt } from './gemini.mjs';
import errorHandler from './error-handler.mjs';

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

app.use(errorHandler);

app.listen(process.env.PORT, async () => {
  console.log(`Better-Music-GPT Listening on port ${config.port}`);
});
