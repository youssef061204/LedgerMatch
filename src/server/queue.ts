import { PgBoss } from 'pg-boss';
export const QUEUE='reconcile';
const state=globalThis as unknown as {ledgerBoss?:Promise<PgBoss>};
export function getBoss() {
  if(!state.ledgerBoss) state.ledgerBoss=(async()=>{
    const boss=new PgBoss({connectionString:process.env.DATABASE_URL,supervise:true});
    boss.on('error',error=>console.error(JSON.stringify({event:'queue_error',message:error.message})));
    await boss.start();await boss.createQueue(QUEUE,{retryLimit:3,retryDelay:3,retryBackoff:true,expireInSeconds:3600,heartbeatSeconds:30});return boss;
  })().catch(error=>{state.ledgerBoss=undefined;throw error;});
  return state.ledgerBoss;
}
