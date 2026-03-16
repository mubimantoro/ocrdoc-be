import { Router } from 'express';
import users from '../services/users/routes/index.js';
import authentications from '../services/authentications/routes/index.js';
import documents from '../services/documents/routes/index.js';
import jobs from '../services/jobs/routes/index.js';

const router = Router();

router.use('/auth', authentications);
router.use('/users', users);
router.use('/documents', documents);
router.use('/jobs', jobs);

export default router;