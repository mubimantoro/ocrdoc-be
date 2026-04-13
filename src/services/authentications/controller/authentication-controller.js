import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { AuthenticationError, InvariantError } from '../../../exceptions/index.js';
import TokenManager from '../../../security/token-manager.js';
import response from '../../../utils/response.js';
import AuthenticationRepositories from '../repositories/authentication-repositories.js';
import UserRepositories from '../../users/repositories/user-repositories.js';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

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

    const hashedRefreshToken = hashToken(refreshToken);
    await AuthenticationRepositories.saveRefreshToken(hashedRefreshToken, payload.id);

    await AuthenticationRepositories.saveRefreshToken(refreshToken, payload.id);

    return response(res, 200, 'Login berhasil', {
      token: accessToken,
      refreshToken: refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
};

export const refreshAccessToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new InvariantError('Refresh token tidak dilampirkan');
    }

    const hashedRefreshToken = hashToken(refreshToken);
    await AuthenticationRepositories.verifyRefreshToken(hashedRefreshToken);

    const payload = await TokenManager.verifyRefreshToken(refreshToken, process.env.REFRESH_TOKEN_KEY);

    const newPayload = {
      id: payload.id,
      name: payload.name,
      email: payload.email,
      role: payload.role
    };

    const newAccessToken = TokenManager.generateAccessToken(newPayload);

    return response(res, 200, 'Access Token berhasil diperbarui', {
      token: newAccessToken
    });
  } catch (error) {
    next(error);
  }
};

export const logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new InvariantError('Refresh token tidak dilampirkan');
    }

    const hashedRefreshToken = hashToken(refreshToken);
    await AuthenticationRepositories.verifyRefreshToken(hashedRefreshToken);
    await AuthenticationRepositories.deleteRefreshToken(hashedRefreshToken);

    return response(res, 200, 'Logout berhasil', null);
  } catch (error) {
    next(error);
  }
};