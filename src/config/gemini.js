
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export const CHEAP_MODEL  = process.env.GEMINI_CHEAP_MODEL;
export const SMART_MODEL  = process.env.GEMINI_SMART_MODEL;

export default ai;