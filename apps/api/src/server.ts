import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });
app.log.info({ host: config.host, port: config.port }, 'Tokia API listening');
