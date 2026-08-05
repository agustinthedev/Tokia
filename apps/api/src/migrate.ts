import { createDatabase } from './db.js';

const db = createDatabase();
db.close();
console.log('SQLite migrations applied.');
