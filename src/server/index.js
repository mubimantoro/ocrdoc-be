import 'dotenv/config';
import express from 'express';
import ErrorHandler from '../middlewares/error.js';
import cors from 'cors';
import routes from '../routes/index.js';
import swaggerUi from 'swagger-ui-express';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const swaggerDocument = yaml.load(fs.readFileSync(path.resolve('./docs/swagger.yaml'), 'utf8'));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: '*',
  credentials: true,
}));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customSiteTitle: 'API Documentation',
  swaggerOptions: { persistAuthorization: true }
}));
app.use('/api', routes);
app.use(ErrorHandler);

export default app;