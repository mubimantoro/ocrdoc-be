import logger from '../../config/logger.js';

/**
 * MICROSERVICE: Gotenberg Excel to PDF Converter
 * Menerima Buffer Excel, mengembalikan Buffer PDF.
 * * Menggunakan Native Fetch API (Node 18+) agar ringan dan tidak butuh form-data pihak ketiga.
 */
export const convertExcelToPdf = async (excelBuffer, originalFileName, log = logger) => {
  const startTime = Date.now();
  log.info({ event: 'gotenberg_start', originalFileName },
    `Konversi Excel ke PDF dimulai: ${originalFileName}`);

  const GOTENBERG_URL = process.env.GOTENBERG_URL;
  const USER = process.env.GOTENBERG_USER;
  const PASS = process.env.GOTENBERG_PASS;

  const headers = {};
  if (USER && PASS) {
    headers['Authorization'] = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
  }

  try {
    // Gunakan Native FormData
    const formData = new FormData();

    // Ubah Buffer Node.js menjadi Blob (Standar Web yang diterima fetch)
    const excelBlob = new Blob([excelBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    // Gotenberg mewajibkan key form-data bernama 'files'
    // Fallback nama file ke document.xlsx jika tidak disediakan
    formData.append('files', excelBlob, originalFileName || 'document.xlsx');

    // KUNCI VISUAL: Render sebagai Landscape
    formData.append('landscape', 'true');

    formData.append('paperWidth', '24');
    formData.append('paperHeight', '4.0');

    const response = await fetch(GOTENBERG_URL, {
      method: 'POST',
      headers: headers, // Header dinamis (dengan atau tanpa auth)
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gotenberg Error ${response.status}: ${errorText}`);
    }

    // Ambil hasil response berupa binary (ArrayBuffer) lalu ubah kembali jadi Node.js Buffer
    const pdfArrayBuffer = await response.arrayBuffer();
    const pdfBuffer = Buffer.from(pdfArrayBuffer);
    const durationMs = Date.now() - startTime;

    log.info({
      event: 'gotenberg_success',
      originalFileName,
      durationMs,
      pdfSizeKb: (pdfBuffer.length / 1024).toFixed(2),
    }, `Konversi sukses dalam ${(durationMs / 1000).toFixed(2)}s — ${(pdfBuffer.length / 1024).toFixed(2)} KB`);

    return pdfBuffer;

  } catch (error) {
    log.error({
      event: 'gotenberg_failed',
      originalFileName,
      err: error,
      ...(error.cause ? { cause: error.cause } : {}),
    }, `Gagal konversi Excel ke PDF: ${error.message}`);
    throw error;
  }
};