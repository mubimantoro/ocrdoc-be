/* eslint-disable no-unused-vars */
import 'dotenv/config';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

// Pastikan direktori fisik selalu mengarah ke folder 'uploads' di root project
const LOCAL_UPLOAD_DIR = path.resolve('uploads');

// Inisialisasi folder secara sinkronus saat server pertama kali berjalan (Cold Start)
if (!existsSync(LOCAL_UPLOAD_DIR)) {
  mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
}


/**
 * Menyimpan buffer file ke Storage Lokal (Digunakan oleh Worker BullMQ untuk menyimpan potongan PDF)
 * Time Complexity: O(1) untuk operasi jaringan (karena local I/O)
 * * @param {string} fileName - Nama file tujuan
 * @param {Buffer} fileBuffer - Buffer biner dari file
 * @param {string} mimeType - Tipe MIME file (misal: application/pdf)
 * @returns {Promise<string>} Relative path file (ex: 'uploads/file.pdf') untuk disimpan ke DB
 */
export const uploadToStorage = async (fileName, fileBuffer, mimeType = 'application/pdf') => {
  try {
    const absoluteFilePath = path.join(LOCAL_UPLOAD_DIR, fileName);

    // Tulis buffer ke hard disk server
    await fs.writeFile(absoluteFilePath, fileBuffer);

    // Kembalikan path relatif murni untuk kebutuhan URL Frontend dan Database
    return `uploads/${fileName}`;
  } catch (error) {
    throw new Error(`[Storage Service] Gagal menyimpan file ${fileName} ke disk: ${error.message}`);
  }
};

/**
 * Membaca file dari Storage lokal dan memotong halaman PDF secara spesifik
 * Space Complexity: O(N) di mana N adalah jumlah halaman yang dipotong (Sangat aman untuk RAM)
 * * @param {string} fileName - Nama file induk di folder uploads
 * @param {number} startPage - Halaman awal (Base-1 index)
 * @param {number} endPage - Halaman akhir (Base-1 index)
 * @returns {Promise<Buffer>} Buffer PDF yang sudah dipotong
 */
export const downloadAndSplitPdf = async (fileName, startPage, endPage) => {
  try {
    const absoluteFilePath = path.join(LOCAL_UPLOAD_DIR, fileName);

    // Validasi eksistensi file untuk menghindari error memori V8
    try {
      await fs.access(absoluteFilePath);
    } catch {
      throw new Error(`File induk ${fileName} tidak ditemukan di storage lokal.`);
    }

    // Baca file fisik dari hard disk ke RAM
    const pdfBuffer = await fs.readFile(absoluteFilePath);

    // Jika parameter halaman tidak valid atau tidak ada, kembalikan file utuh
    if (!startPage || !endPage || startPage > endPage) {
      return pdfBuffer;
    }

    // Load AST PDF ke memori menggunakan pdf-lib
    const originalPdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const totalPages = originalPdf.getPageCount();

    // Validasi Boundary: Pastikan tidak memotong melebihi jumlah halaman aslinya
    const safeStart = Math.max(1, startPage);
    const safeEnd = Math.min(totalPages, endPage);

    const newPdf = await PDFDocument.create();

    // Konversi dari Base-1 (manusia) ke Base-0 (array indexing PDF-lib)
    const pageIndices = [];
    for (let i = safeStart - 1; i <= safeEnd - 1; i++) {
      pageIndices.push(i);
    }

    // Salin halaman yang dibutuhkan
    const copiedPages = await newPdf.copyPages(originalPdf, pageIndices);
    copiedPages.forEach((page) => newPdf.addPage(page));

    // Export PDF baru menjadi Buffer biner
    const newPdfBytes = await newPdf.save();
    return Buffer.from(newPdfBytes);

  } catch (error) {
    console.error('[Storage Service] Error pada PDF Splitting:', error.message);
    throw error;
  }
};