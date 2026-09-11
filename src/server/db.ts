import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

pg.types.setTypeParser(20, (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds exact JavaScript range.');
  return number;
});
pg.types.setTypeParser(1082, (value) => value);
const globalDb = globalThis as unknown as { ledgerPool?: pg.Pool };
export const pool = globalDb.ledgerPool ?? new pg.Pool({connectionString:process.env.DATABASE_URL,max:10});
if (process.env.NODE_ENV !== 'production') globalDb.ledgerPool = pool;
export const db = drizzle(pool, {schema});
export type Client = pg.PoolClient;
export async function transaction<T>(fn:(client:Client)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
