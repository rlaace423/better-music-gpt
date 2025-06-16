import axios from 'axios';
import config from './config.mjs';

const MUSIC_GPT_API_BASE_URL = 'https://api.musicgpt.com/api/public/v1';

export async function generateSong(body) {
  const result = await axios.post(`${MUSIC_GPT_API_BASE_URL}/MusicAI`, body, {
    headers: { Authorization: config.musicGptApiKey },
  });
  console.log(result.data);
  return result.data;
}

export async function getSongStatus(taskId) {
  try {
    const result = await axios.get(`${MUSIC_GPT_API_BASE_URL}/byId`, {
      headers: { Authorization: config.musicGptApiKey },
      params: {
        conversionType: 'MUSIC_AI',
        task_id: taskId,
      },
    });
    console.log(result.data);
    return result.data;
  } catch (e) {
    console.error(e);
  }
}
