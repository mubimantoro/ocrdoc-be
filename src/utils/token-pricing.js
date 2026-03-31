/* eslint-disable camelcase */
const PRICING = {
  'gemini-2.5-flash-lite': {
    input:  0.10, // $0.10 / 1M input tokens
    output: 0.40, // $0.40 / 1M output tokens
  },
  'gemini-2.5-flash': {
    input:  0.30, // $0.30 / 1M input tokens
    output: 2.50, // $2.50 / 1M output tokens
  },
};

const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Hitung estimasi biaya berdasarkan model dan jumlah token
 * @param {string} model   - nama model Gemini
 * @param {number} promptTokens  - jumlah input token
 * @param {number} outputTokens  - jumlah output token
 * @returns {{ input_price, output_price, total_price }}
 */
export const calculatePrice = (model, promptTokens, outputTokens) => {
  const pricing = PRICING[model] ?? PRICING[DEFAULT_MODEL];

  const inputPrice  = (promptTokens  / 1_000_000) * pricing.input;
  const outputPrice = (outputTokens  / 1_000_000) * pricing.output;
  const totalPrice  = inputPrice + outputPrice;

  return {
    input_price:  parseFloat(inputPrice.toFixed(8)),
    output_price: parseFloat(outputPrice.toFixed(8)),
    total_price:  parseFloat(totalPrice.toFixed(8)),
  };
};