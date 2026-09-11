import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pool, transaction } from '../src/server/db';
await transaction(async client=>{
  await client.query("SELECT pg_advisory_xact_lock(48203912)");
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())');
  for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) {
    const sql=await readFile(`migrations/${name}`,'utf8'); const hash=createHash('sha256').update(sql).digest('hex');
    const existing=await client.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name]);
    if(existing.rows.length) { if(existing.rows[0].checksum!==hash) throw new Error(`Migration ${name} was modified after application.`); continue; }
    await client.query(sql); await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,hash]); console.log(`Applied ${name}`);
  }
});
await pool.end();
