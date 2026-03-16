/* eslint-disable no-unused-vars */
import jwt from 'jsonwebtoken';
import { InvariantError } from '../exceptions/index.js';

const TokenManager = {
  generateAccessToken(payload) {
    return jwt.sign(payload, process.env.ACCESS_TOKEN_KEY, {
      expiresIn: process.env.ACCESS_TOKEN_AGE ?? '15m'
    });
  },
  generateRefreshToken(payload) {
    return jwt.sign(payload, process.env.REFRESH_TOKEN_KEY, {
      expiresIn: process.env.REFRESH_TOKEN_AGE ?? '7d',
    });
  },

  verifyAccessToken(token) {
    try {
      return jwt.verify(token, process.env.ACCESS_TOKEN_KEY);
    } catch (err) {
      throw new InvariantError('Access token tidak valid');
    }
  },

  verifyRefreshToken(token) {
    try {
      return jwt.verify(token, process.env.REFRESH_TOKEN_KEY);
    } catch (err) {
      throw new InvariantError('Refresh token tidak valid');
    }
  },

};

export default TokenManager;