import { createDatabase } from './db.js';
import { readConfig } from './config.js';
import { applyMigrations } from './migrations.js';
const config=readConfig(),db=createDatabase(config.databaseUrl);
try{const applied=await applyMigrations(db);console.log(JSON.stringify({migrations:applied,status:'ready'}));}
finally{await db.close();}
