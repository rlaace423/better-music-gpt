import dotenv from 'dotenv';

dotenv.config();

const config = {
  port: process.env.PORT || 3000,
  geminiApiKey: process.env.GEMINI_API_KEY,
  musicGptApiKey: process.env.MUSIC_GPT_API_KEY,
};

export default config;
