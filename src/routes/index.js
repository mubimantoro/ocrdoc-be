import { Router } from 'express';
import users from '../services/users/routes/index.js';
import authentications from '../services/authentications/routes/index.js';
import documents from '../services/documents/routes/index.js';
import jobs from '../services/jobs/routes/index.js';
import sourceFiles from '../services/source-files/routes/index.js';
import stream from '../sse/routes/index.js';

const router = Router();

router.use('/auth', authentications);
router.use('/users', users);
router.use('/documents', documents);
router.use('/jobs', jobs);
router.use('/source-files', sourceFiles);
router.use('/', stream);

export default router;