import { Router } from 'express';
import users from '../services/users/routes/index.js';
import authentications from '../services/authentications/routes/index.js';
import documents from '../services/documents/routes/index.js';

const router = Router();

router.use('/auth', authentications);
router.use('/users', users);
router.use('/documents', documents);

export default router;