/**
 * Utility untuk membersihkan respons AI dari format Markdown Code Block
 * dan mengonversinya menjadi Object JavaScript yang valid.
 * * @param {string} rawText - Teks mentah dari respons AI
 * @returns {object} - Object JSON hasil parsing
 */
export const cleanAIJson = (rawText) => {
  if (!rawText) {
    throw new Error('Respons AI kosong (null/undefined).');
  }

  try {
    const cleanedText = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    return JSON.parse(cleanedText);

  } catch (error) {
    console.error('\n[AI SANITIZER ERROR] Gagal melakukan parsing JSON:');
    console.error('Error Message:', error.message);
    console.error('--- RAW TEXT BEGIN ---');
    console.error(rawText);
    console.error('--- RAW TEXT END ---\n');

    throw new Error('Gagal mengekstrak data JSON dari respons AI. Format tidak valid.');
  }
};