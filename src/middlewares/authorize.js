import { AuthorizationError } from '../exceptions/index.js';

const authorizeRole = (allowedRoles) => {
  return (req, res, next) => {
    try {
      // 1. Safety Check: Pastikan middleware auth.js sudah berjalan dan mengisi req.user
      if (!req.user || !req.user.role) {
        throw new AuthorizationError('Unauthorized');
      }

      // 2. Periksa apakah role user saat ini ada di dalam daftar role yang diizinkan
      if (!allowedRoles.includes(req.user.role)) {
        throw new AuthorizationError('Forbidden');
      }

      // 3. Jika cocok, silakan masuk ke Controller!
      return next();
    } catch (error) {
      // Lempar error ke Global Error Handler di tingkat Express (app.use)
      return next(error);
    }
  };
};

export default authorizeRole;