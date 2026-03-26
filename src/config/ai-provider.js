/* eslint-disable camelcase */
import { GoogleGenAI } from '@google/genai';
import { readFile } from 'fs/promises';

const PRICING = {
  'gemini-2.5-flash-lite': { input: 0.10,  output: 0.40  },
  'gemini-2.5-flash': { input: 0.30,  output: 2.50  },
  'gemini-2.0-flash': { input: 0.075, output: 0.30  },
  'gemini-3-flash-preview':{ input: 0.075, output: 0.30  },
};

const calcPrice = (model, inputTokens, outputTokens) => {
  const price  = PRICING[model] || { input: 0, output: 0 };
  const input  = (inputTokens  / 1_000_000) * price.input;
  const output = (outputTokens / 1_000_000) * price.output;
  return {
    input_price:  parseFloat(input.toFixed(8)),
    output_price: parseFloat(output.toFixed(8)),
    total_price:  parseFloat((input + output).toFixed(8)),
  };
};

class GeminiProvider {
  #ai;

  constructor() {
    this.#ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async generateText(prompt, { model } = {}) {
    const usedModel = model || process.env.GEMINI_CHEAP_MODEL || 'gemini-2.5-flash-lite';

    const response = await this.#ai.models.generateContent({
      model:    usedModel,
      contents: [{ parts: [{ text: prompt }] }],
    });

    const inputTokens  = response.usageMetadata?.promptTokenCount     || 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
    const prices = calcPrice(usedModel, inputTokens, outputTokens);

    return {
      text: response.text,
      usage: {
        model: usedModel,
        input_tokens:  inputTokens,
        output_tokens: outputTokens,
        total_tokens:  inputTokens + outputTokens,
        ...prices,
      },
    };
  }

  async generateWithFile(prompt, filePath, mimeType, { model } = {}) {
    const usedModel = model || process.env.GEMINI_SMART_MODEL || 'gemini-2.5-flash';
    const buffer = await readFile(filePath);
    const base64 = buffer.toString('base64');

    const response = await this.#ai.models.generateContent({
      model: usedModel,
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64 } },
        ],
      }],
    });

    const inputTokens  = response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
    const prices = calcPrice(usedModel, inputTokens, outputTokens);

    return {
      text: response.text,
      usage: {
        model: usedModel,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens:  inputTokens + outputTokens,
        ...prices,
      },
    };
  }
}

const PROVIDERS = {
  gemini: GeminiProvider,
};

const getProvider = () => {
  const providerName = process.env.AI_PROVIDER || 'gemini';
  const Provider = PROVIDERS[providerName];

  if (!Provider) {
    throw new Error(`AI provider '${providerName}' tidak tersedia. Pilihan: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  return new Provider();
};

export default getProvider;