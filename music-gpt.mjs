import axios from 'axios';
import { RunnableLambda } from '@langchain/core/runnables';
import config from './config.mjs';

const MUSIC_GPT_API_BASE_URL = 'https://api.musicgpt.com/api/public/v1';

/*
 * MusicGPT 호출을 RunnableLambda로 감싸 LCEL/LangGraph 노드와 호환되도록 한다.
 * Phase 2(LangGraph)의 musicGptCall / pollStatus 노드는 이 Runnable을 그대로 사용.
 */

async function generateSongImpl(body) {
  const result = await axios.post(`${MUSIC_GPT_API_BASE_URL}/MusicAI`, body, {
    headers: { Authorization: config.musicGptApiKey },
  });
  console.log(result.data);
  return result.data;
}

async function getSongStatusImpl(taskId) {
  try {
    const result = await axios.get(`${MUSIC_GPT_API_BASE_URL}/byId`, {
      headers: { Authorization: config.musicGptApiKey },
      params: { conversionType: 'MUSIC_AI', task_id: taskId },
    });
    console.log(result.data);
    return result.data;
  } catch (e) {
    console.error(e);
    return undefined;
  }
}

// LCEL / LangGraph 노드용 Runnable
export const generateSongRunnable = RunnableLambda.from(generateSongImpl);
export const getSongStatusRunnable = RunnableLambda.from(getSongStatusImpl);

// 기존 호출자(index.mjs)와의 호환 — 동일한 이름으로 일반 함수도 export
export async function generateSong(body) {
  return generateSongRunnable.invoke(body);
}

export async function getSongStatus(taskId) {
  return getSongStatusRunnable.invoke(taskId);
}
