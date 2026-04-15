import { Router } from 'express';
import users from '../services/users/routes/index.js';
import authentications from '../services/authentications/routes/index.js';
import documents from '../services/documents/routes/index.js';
import sourceFiles from '../services/source-files/routes/index.js';
import dashboard from '../services/dashboard/routes/index.js';

const router = Router();

router.use('/auth', authentications);
router.use('/users', users);
router.use('/documents', documents);
router.use('/source-files', sourceFiles);
router.use('/dashboard', dashboard);

export default router;