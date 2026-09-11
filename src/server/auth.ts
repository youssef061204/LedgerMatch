import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { pool } from './db';
import { AppError, type Context } from './service';
export async function sessionCookie() {
  const password=process.env.SESSION_PASSWORD;
  if(!password||password.length<32) throw new Error('Set SESSION_PASSWORD to at least 32 random characters.');
  return getIronSession<{id?:string}>(await cookies(),{password,cookieName:'ledger_session',ttl:7*24*3600,cookieOptions:{httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',path:'/'}});
}
export async function context():Promise<Context & {sessionId:string}> {
  const session=await sessionCookie();
  if(!session.id) throw new AppError('Enter a demo workspace to continue.',401);
  const result=await pool.query('SELECT workspace_id AS "workspaceId",principal_id AS "principalId",id AS "sessionId" FROM sessions WHERE id=$1 AND expires_at>now()',[session.id]);
  if(!result.rows[0]) throw new AppError('Your demo session expired. Enter a new workspace to continue.',401);
  return result.rows[0];
}
