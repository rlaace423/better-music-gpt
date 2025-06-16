import axios from 'axios';
import config from './config.mjs';

export async function generateSong(body) {
  const result = await axios.post('https://api.musicgpt.com/api/public/v1/MusicAI', body, { headers: { 'Authorization': config.musicGptApiKey } });
  console.log (result.data);
  return result.data;
}
