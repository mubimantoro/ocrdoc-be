import { AuthorizationError } from '../exceptions/index.js';

const authorize = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return next(new AuthorizationError('Anda tidak memiliki akses ke resource ini'));
  }

  next();
};

export default authorize;