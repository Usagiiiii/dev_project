import fs from 'node:fs';
import { closeDb, getDbPath } from '../src/db.js';

closeDb();
const dbPath = getDbPath();
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log('removed', dbPath);
} else {
  console.log('no db file at', dbPath);
}
