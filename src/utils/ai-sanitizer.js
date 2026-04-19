/**
 * Utility untuk memperbaiki JSON yang terpotong (Truncated) secara otomatis
 */
const repairTruncatedJson = (jsonString) => {
  let repaired = jsonString.trim();

  /**
   * 🛡️ ADVANCED CLEANUP
   * Jika JSON terpotong di tengah jalan, biasanya berakhir dengan:
   * - Tanda koma menggantung: ... "key": "val",
   * - Tanda kutip menggantung: ... "key": "v
   * - Nama key menggantung: ... "ke
   * Kita hapus karakter-karakter ini sampai menemukan batas data yang valid.
   */
  const isSafeEnding = (str) => /["}\]]|true|false|null|\d$/.test(str);

  // Bersihkan karakter di ujung secara mundur sampai menemukan "Safe Ending"
  // Limit 100 iterasi untuk mencegah infinite loop (walaupun hampir tidak mungkin)
  let safetyCounter = 0;
  while (repaired.length > 0 && !isSafeEnding(repaired) && safetyCounter < 100) {
    repaired = repaired.slice(0, -1).trim();
    safetyCounter++;
  }

  // Jika setelah dibersihkan berakhir dengan koma, hapus komanya agar valid
  if (repaired.endsWith(',')) {
    repaired = repaired.slice(0, -1).trim();
  }

  // 2. Hitung jumlah kurung yang terbuka dan tertutup
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;

  // 3. Tambahkan penutup yang kurang secara sekuensial
  let diffBraces = openBraces - closeBraces;
  let diffBrackets = openBrackets - closeBrackets;

  // Tutup array dulu (jika ada) baru tutup object
  while (diffBrackets > 0) {
    repaired += ']';
    diffBrackets--;
  }
  while (diffBraces > 0) {
    repaired += '}';
    diffBraces--;
  }

  return repaired;
};

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

  const cleanedText = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleanedText);
  } catch (error) {
    // 🛡️ COBA PERBAIKI JIKA TERPOTONG
    try {
      console.warn('[AI SANITIZER] Mendeteksi JSON terpotong, mencoba melakukan perbaikan...');
      const repairedText = repairTruncatedJson(cleanedText);
      return JSON.parse(repairedText);
    } catch (repairError) {
      console.error('\n[AI SANITIZER ERROR] Gagal melakukan parsing JSON bahkan setelah perbaikan:');
      console.error('Error Message:', error.message, repairError.message);
      console.error('--- RAW TEXT BEGIN ---');
      console.error(rawText);
      console.error('--- RAW TEXT END ---\n');

      throw new Error('Gagal mengekstrak data JSON dari respons AI. Format tidak valid setelah upaya perbaikan.');
    }
  }
};