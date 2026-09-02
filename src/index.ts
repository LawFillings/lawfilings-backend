import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { catalogRouter } from './routes/catalog.js';
import { casesRouter } from './routes/cases.js';
import { authRouter } from './routes/auth.js';
import { copilotRouter } from './routes/copilot.js';
import { lawLibraryRouter } from './routes/lawLibrary.js';
import { billingRouter } from './routes/billing.js';
import { adminRouter } from './routes/admin.js';
import { globalLimiter } from './middleware/rateLimit.js';

const app = express();

// exposedHeaders: browsers hide all but a small default set of response headers from JS unless
// the server explicitly allows them — X-Translation-Truncated (set by /api/copilot/translate-
// document) needs to be readable via fetch()'s Response.headers.
app.use(cors({ exposedHeaders: ['X-Translation-Truncated'] }));
// Express's default 100kb body limit is too small for /api/copilot/translate-document, which can
// receive a full Act's text client-side (the largest, the Constitution, is ~470kb) before the
// route truncates it server-side for the actual translation call.
app.use(express.json({ limit: '1mb' }));
app.use(globalLimiter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRouter);
app.use('/api', catalogRouter);
app.use('/api/cases', casesRouter);
app.use('/api/copilot', copilotRouter);
app.use('/api/law-library', lawLibraryRouter);
app.use('/api/billing', billingRouter);
app.use('/api/admin', adminRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});
