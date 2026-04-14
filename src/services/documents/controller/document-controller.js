/* eslint-disable camelcase */
import { extractionQueue } from '../../../config/queue.js';
import { InvariantError, NotFoundError } from '../../../exceptions/index.js';
import { formatDocumentResponse, formatListDocumentResponse } from '../../../utils/mapper/document-mapper.js';
import { transformRawData } from '../../../utils/mapper/raw-transformer.js';
import response from '../../../utils/response.js';
import DocumentRepositories from '../repositories/document-repositories.js';

export const getDocuments = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const offset = (page - 1) * limit;

    const filters = {};
    if (req.query.source_file_id) filters.sourceFileId = req.query.source_file_id;

    // Eksekusi count dan list data secara paralel
    const [totalItems, rawDocs] = await Promise.all([
      DocumentRepositories.countAll(filters),
      DocumentRepositories.findAll(limit, offset, filters)
    ]);

    const formattedData = rawDocs.map((doc) => formatListDocumentResponse(doc));
    const totalPages = Math.ceil(totalItems / limit);

    const pagination = {
      page,
      limit,
      total_items: parseInt(totalItems, 10),
      total_pages: totalPages,
      has_next_page: page < totalPages,
      has_prev_page: page > 1
    };

    return response(res, 200, 'Berhasil mengambil daftar dokumen', formattedData, pagination);
  } catch (error) {
    next(error);
  }
};

export const getDocumentDetail = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { raw } = req.query;

    // Ambil data Induk + Relasi + EAV Arrays
    const { document, fields, items, rawData } = await DocumentRepositories.findById(id);

    // Format menjadi Nested JSON
    const formattedData = formatDocumentResponse(document, fields, items);

    if (raw === 'true' && rawData) {
      const sortedRaw = transformRawData(rawData, document.doc_type_code);
      return res.status(200).json(sortedRaw);
    }

    return response(res, 200, 'Berhasil mengambil detail dokumen', formattedData);
  } catch (error) {
    next(error);
  }
};

/**
 * Controller: Memproses ulang dokumen yang gagal (Retry)
 */
export const retryDocument = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { document } = await DocumentRepositories.findById(id);
    if (!document) {
      throw new NotFoundError('Dokumen tidak ditemukan');
    }

    if (document.status === 'completed') {
      throw new InvariantError('Dokumen sudah berhasil diproses, tidak perlu di-retry');
    }

    await DocumentRepositories.updateStatus(id, 'queued', null);


    await extractionQueue.add('extract-data', {
      documentId: document.id,
      sourceFileId: document.source_file_id,
      splitFilePath: document.file_path,
      docCode: document.doc_type_code
    });

    return response(res, 200, 'Dokumen berhasil dimasukkan kembali ke antrean untuk diproses ulang');
  } catch (error) {
    next(error);
  }
};