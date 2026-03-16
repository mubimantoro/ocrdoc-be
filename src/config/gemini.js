
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export const CHEAP_MODEL  = process.env.GEMINI_CHEAP_MODEL  || 'gemini-2.0-flash';
export const SMART_MODEL  = process.env.GEMINI_SMART_MODEL  || 'gemini-2.5-pro-preview-05-06';

export default ai;