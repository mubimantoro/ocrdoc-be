import 'dotenv/config';
import express from 'express';
import ErrorHandler from '../middlewares/error.js';
import cors from 'cors';
import routes from '../routes/index.js';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'fs';
import yaml from 'js-yaml';

const swaggerDoc = yaml.load(readFileSync('./swagger.yaml', 'utf-8'));

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: '*'
}));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));
app.use('/api', routes);
app.use(ErrorHandler);

export default app;