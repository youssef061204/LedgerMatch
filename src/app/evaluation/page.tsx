import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Link from 'next/link';
import EvaluationDashboard from '../../components/evaluation-dashboard';

export const dynamic='force-dynamic';
export const metadata={title:'LedgerMatch | Model evaluation'};
export default async function EvaluationPage() {
  let report;
  try { report=JSON.parse(await readFile(join(process.cwd(),'public/evaluation/latest.json'),'utf8')); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    return <main style={{maxWidth:800,margin:'80px auto',padding:24}}><Link href="/">Back to LedgerMatch</Link><h1>No experiment report yet</h1><p>Generate an evaluation with <code>npm run ml:evaluate</code> and <code>npm run ml:report</code>.</p></main>;
  }
  return <EvaluationDashboard report={report}/>;
}
