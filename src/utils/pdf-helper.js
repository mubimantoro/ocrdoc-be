import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { nanoid } from 'nanoid';

export const getPdfPageCount = async (filePath) => {
  const pdfBytes = await readFile(filePath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  return pdfDoc.getPageCount();
};

export const splitPdf = async (srcPath, startPage, endPage, outputDir) => {
  const pdfBytes = await readFile(srcPath);
  const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const newDoc = await PDFDocument.create();

  const indexes   = Array.from(
    { length: endPage - startPage + 1 },
    (_, i) => startPage - 1 + i
  );
  const pages = await newDoc.copyPages(srcDoc, indexes);
  pages.forEach((p) => newDoc.addPage(p));

  const outBytes = await newDoc.save();
  const outName = `doc_${startPage}-${endPage}_${Date.now()}_${nanoid(10)}.pdf`;
  const outPath = path.join(outputDir, outName);
  await writeFile(outPath, outBytes);

  return outPath;
};