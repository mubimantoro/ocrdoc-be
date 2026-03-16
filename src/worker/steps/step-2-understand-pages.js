import { readFile } from 'fs/promises';
import ai, { MODEL } from '../../config/gemini.js';

const PROMPT = `
You are a document parser for a freight forwarding and logistics company.
Analyze this document page carefully.

Extract ALL content you see including:
- All text, numbers, dates
- Tables (preserve rows and columns)
- Key-value pairs (label: value)
- Headers and footers
- Stamps or markings

Return the full structured content as plain text.
Preserve the layout as much as possible.
Do NOT summarize — extract everything.
`;

const understandPages = async (images) => {
  const results = [];

  for (const { pageIndex, imagePath } of images) {
    const base64Image = (await readFile(imagePath)).toString('base64');
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [
        { text: PROMPT },
        { inlineData: { mimeType: 'image/png', data: base64Image } }
      ]
    });
    results.push({ pageIndex, imagePath, rawText: resp.text });
  }
  return results;
};

export default understandPages;