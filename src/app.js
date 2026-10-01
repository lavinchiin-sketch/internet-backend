require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { corsOptions } = require('./config/cors');
const { uploadDir } = require('./middleware/upload');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
app.set('trust proxy', 1); // behind Railway / Vercel proxies
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // allow the PWAs to display uploaded photos
app.use(cors(corsOptions()));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'INTERNet API', version: '2.0.0', time: new Date() }));
app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);
module.exports = app;
