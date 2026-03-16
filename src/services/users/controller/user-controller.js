import bcrypt from 'bcrypt';
import { InvariantError } from '../../../exceptions/index.js';
import UserRepositories from '../repositories/user-repositories.js';
import response from '../../../utils/response.js';

export const getAll = async (req, res, next) => {
  try {
    const users = await UserRepositories.findAll();
    return response(res, 200, 'Berhasil mengambil daftar user', users);
  } catch (err) {
    next(err);
  }
};

export const getById = async (req, res, next) => {
  try {
    const user = await UserRepositories.findById(req.params.id);
    return response(res, 200, 'Berhasil mengambil data user', user);
  } catch (err) {
    next(err);
  }
};

export const create = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role)
      return next(new InvariantError('name, email, password, dan role wajib diisi'));
    if (password.length < 8)
      return next(new InvariantError('Password minimal 8 karakter'));
    if (!['admin', 'operator'].includes(role))
      return next(new InvariantError('Role harus admin atau operator'));

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = await UserRepositories.create({
      name,
      email,
      hashedPassword,
      roleName: role
    });

    const user = await UserRepositories.findById(userId);
    return response(res, 201, 'User berhasil dibuat', user);
  } catch (err) { next(err); }
};

export const update = async (req, res, next) => {
  try {
    const { name, email, role } = req.body;

    if (!name && !email && !role)
      return next(new InvariantError('Minimal satu field harus diisi (name, email, atau role)'));
    if (role && !['admin', 'operator'].includes(role))
      return next(new InvariantError('Role harus admin atau operator'));

    await UserRepositories.update(req.params.id, {
      name,
      email,
      roleName: role,
    });

    const user = await UserRepositories.findById(req.params.id);
    return response(res, 200, 'User berhasil diupdate', user);
  } catch (err) { next(err); }
};


export const deleteUser = async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return next(new InvariantError('Tidak dapat menghapus akun sendiri'));
    }

    await UserRepositories.delete(req.params.id);

    return response(res, 200, 'User berhasil dihapus');
  } catch (err) {
    next(err);
  }
};