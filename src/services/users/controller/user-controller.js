import bcrypt from 'bcrypt';
import { InvariantError, NotFoundError } from '../../../exceptions/index.js';
import UserRepositories from '../repositories/user-repositories.js';
import response from '../../../utils/response.js';

/**
 * Controller: Membuat User Baru
 */
export const createUser = async (req, res, next) => {
  try {
    const { name, email, password, role  } = req.body;

    if (!name || !email || !password) {
      throw new InvariantError('Nama, email, dan password wajib diisi');
    }

    const existingUser = await UserRepositories.findByEmail(email);
    if (existingUser) {
      throw new InvariantError('Email sudah terdaftar. Silakan gunakan email lain.');
    }

    const roleData = await UserRepositories.findRoleByName(role);
    if (!roleData) {
      throw new InvariantError(`Role '${role}' tidak ditemukan di database.`);
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const newUser = await UserRepositories.createUser(
      name,
      email,
      hashedPassword,
      roleData.id
    );

    const responseData = {
      ...newUser,
      role: roleData.name
    };

    return response(res, 201, 'User berhasil dibuat', responseData);
  } catch (error) {
    next(error);
  }
};

export const getUsers = async (req, res, next) => {
  try {
    const users = await UserRepositories.getUsers();
    return response(res, 200, 'Berhasil mengambil daftar user', users);
  } catch (error) {
    next(error);
  }
};

/**
 * Controller: Mendapatkan detail user berdasarkan ID
 */
export const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = await UserRepositories.getUserById(id);

    if (!user) {
      throw new NotFoundError('User tidak ditemukan');
    }

    return response(res, 200, 'Berhasil mengambil detail user', user);
  } catch (error) {
    next(error);
  }
};

/**
 * Controller: Mengupdate data user
 */
export const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, role } = req.body;

    if (!name || !role) {
      throw new InvariantError('Nama dan Role wajib diisi');
    }

    // 1. Pastikan user exist
    const existingUser = await UserRepositories.getUserById(id);
    if (!existingUser) {
      throw new NotFoundError('User tidak ditemukan');
    }

    // 2. Cari ID Role yang baru
    const roleData = await UserRepositories.findRoleByName(role);
    if (!roleData) {
      throw new InvariantError(`Role '${role}' tidak ditemukan.`);
    }

    // 3. Update
    const updatedUser = await UserRepositories.updateUser(id, name, roleData.id);

    return response(res, 200, 'User berhasil diperbarui', {
      ...updatedUser,
      role: roleData.name
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Controller: Menghapus user
 */
export const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Proteksi: Admin tidak boleh menghapus dirinya sendiri
    if (req.user.id === id) {
      throw new InvariantError('Anda tidak dapat menghapus akun Anda sendiri');
    }

    const isDeleted = await UserRepositories.deleteUser(id);
    if (!isDeleted) {
      throw new NotFoundError('User tidak ditemukan');
    }

    return response(res, 200, 'User berhasil dihapus', null);
  } catch (error) {
    next(error);
  }
};

/**
 * Controller: Reset Password oleh Admin
 */
export const resetPassword = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      throw new InvariantError('Password baru wajib diisi dan minimal 6 karakter');
    }

    // 1. Pastikan user exist
    const existingUser = await UserRepositories.getUserById(id);
    if (!existingUser) {
      throw new NotFoundError('User tidak ditemukan');
    }

    // 2. Hash password baru
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // 3. Update di database
    await UserRepositories.updatePassword(id, hashedPassword);

    return response(res, 200, 'Password user berhasil direset', null);
  } catch (error) {
    next(error);
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


/* export const deleteUser = async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return next(new InvariantError('Tidak dapat menghapus akun sendiri'));
    }

    await UserRepositories.delete(req.params.id);

    return response(res, 200, 'User berhasil dihapus');
  } catch (err) {
    next(err);
  }
}; */