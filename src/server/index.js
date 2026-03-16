import 'dotenv/config';
import express from 'express';
import ErrorHandler from '../middlewares/error.js';
import cors from 'cors';
import routes from '../routes/index.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: '*'
}));
app.use('/api', routes);
app.use(ErrorHandler);

export default app;