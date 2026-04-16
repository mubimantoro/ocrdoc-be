import dotenv from 'dotenv';
dotenv.config();
import { GoogleGenAI } from '@google/genai';

export const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export const MODELS = {
  CHEAP: 'gemini-3.1-flash-lite-preview',
  FLAGSHIP: 'gemini-3-flash-preview'
};