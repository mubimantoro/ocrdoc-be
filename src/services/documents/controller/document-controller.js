import { InvariantError } from '../../../exceptions/index.js';
import response from '../../../utils/response.js';
import DocumentRepositories from '../repositories/document-repositories.js';

export const getAll = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sourceFileId = req.query.source_file_id  || null;
    if (page < 1 || limit < 1) {
      return next(new InvariantError('page dan limit harus berupa angka positif'));
    }

    const result = await DocumentRepositories.findAll({ page, limit, sourceFileId });
    return response(res, 200, 'Berhasil mengambil daftar dokumen', result);
  } catch (err) {
    next(err);
  }
};

export const getById = async (req, res, next) => {
  try {
    const doc = await DocumentRepositories.findById(req.params.id);
    return response(res, 200, 'Berhasil mengambil detail dokumen', doc);
  } catch (err) { next(err); }
};
