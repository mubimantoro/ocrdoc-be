import bcrypt from 'bcrypt';
import { AuthenticationError, InvariantError } from '../../../exceptions/index.js';
import TokenManager from '../../../security/token-manager.js';
import response from '../../../utils/response.js';
import AuthenticationRepositories from '../repositories/authentication-repositories.js';
import UserRepositories from '../../users/repositories/user-repositories.js';

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return next(new InvariantError('Email dan password wajib diisi'));

    const user = await UserRepositories.findByEmail(email);
    if (!user) return next(new AuthenticationError('Email atau password salah'));

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return next(new AuthenticationError('Email atau password salah'));

    const payload = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    const accessToken  = TokenManager.generateAccessToken(payload);
    const refreshToken = TokenManager.generateRefreshToken(payload);

    await AuthenticationRepositories.saveRefreshToken(refreshToken);

    return response(res, 200, 'Login berhasil', {
      token: accessToken, refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
};

export const refresh = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return next(new InvariantError('Refresh token wajib diisi'));
    }

    await AuthenticationRepositories.verifyRefreshToken(refreshToken);

    const decoded = TokenManager.verifyRefreshToken(refreshToken);
    const accessToken = TokenManager.generateAccessToken({
      id: decoded.id, name: decoded.name, email: decoded.email, role: decoded.role,
    });

    return response(res, 200, 'Access token diperbarui', { token: accessToken });
  } catch (err) {
    next(err);
  }
};

export const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return next(new InvariantError('Refresh token wajib diisi'));
    }

    await AuthenticationRepositories.deleteRefreshToken(refreshToken);

    return response(res, 200, 'Logout berhasil');
  } catch (err) {
    next(err);
  }
};