import type { Sample } from './dataset';
import { HOLD_STATUSES, rankVectors, type Model } from './model';

export interface Outcome { id:string;scenario:string;difficulty:string;valid:boolean;retrieved:boolean;rank:number|null;candidateCount:number;topInvoiceId:string|null;truth:string|null;confidence:number;accepted:boolean;correct:boolean;held:boolean; }
export function outcome(sample:Sample,model:Model):Outcome {
  const ranked=rankVectors(model,sample.x,sample.candidates.map(c=>c.invoiceId));
  const position=ranked.order.findIndex(i=>sample.y[i]===1);
  const top=ranked.order.length?sample.candidates[ranked.order[0]].invoiceId:null;
  const held=HOLD_STATUSES.has(sample.status);
  return {id:sample.id,scenario:sample.scenario,difficulty:sample.difficulty,valid:sample.validMatchExists,retrieved:position>=0,rank:position<0?null:position+1,candidateCount:sample.candidates.length,topInvoiceId:top,truth:sample.trueInvoiceId,confidence:ranked.confidence,accepted:!!top&&!held&&ranked.confidence>=model.threshold,correct:!!top&&top===sample.trueInvoiceId,held};
}
export const divide=(a:number,b:number)=>b?a/b:null;
export function wilson(correct:number,total:number):[number,number]|null {
  if(!total)return null;const z=1.96,p=correct/total,d=1+z*z/total;
  const centre=(p+z*z/(2*total))/d,range=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;
  return [Math.max(0,centre-range),Math.min(1,centre+range)];
}
export function summarize(rows:Outcome[]) {
  const valid=rows.filter(r=>r.valid),accepted=rows.filter(r=>r.accepted),correct=accepted.filter(r=>r.correct).length;
  const absent=rows.filter(r=>!r.valid),noCandidate=rows.filter(r=>!r.retrieved);
  const nonempty=rows.filter(r=>r.candidateCount>0);
  const bins=Array.from({length:10},(_,i)=>{
    const values=nonempty.filter(r=>Math.min(9,Math.floor(r.confidence*10))===i);
    return {lower:i/10,upper:(i+1)/10,count:values.length,confidence:divide(values.reduce((s,r)=>s+r.confidence,0),values.length),accuracy:divide(values.filter(r=>r.correct).length,values.length)};
  });
  const inspected=valid.map(r=>r.rank!==null&&r.rank<=5?r.rank:Math.min(r.candidateCount,5)+1);
  return {samples:rows.length,validMatches:valid.length,noValidInvoice:absent.length,candidatePairs:rows.reduce((s,r)=>s+r.candidateCount,0),
    top1Accuracy:divide(valid.filter(r=>r.rank===1).length,valid.length),top3Recall:divide(valid.filter(r=>r.rank!==null&&r.rank<=3).length,valid.length),
    mrr:divide(valid.reduce((s,r)=>s+(r.rank?1/r.rank:0),0),valid.length),candidateRecall:divide(valid.filter(r=>r.retrieved).length,valid.length),
    accepted:accepted.length,correctAccepted:correct,falseRecommendations:accepted.length-correct,abstentions:rows.length-accepted.length,
    precision:divide(correct,accepted.length),precisionWilson95:wilson(correct,accepted.length),coverage:divide(accepted.length,rows.length),acceptedRecall:divide(correct,valid.length),abstentionRate:divide(rows.length-accepted.length,rows.length),incorrectRecommendationRate:divide(accepted.length-correct,rows.length),
    noMatchRecall:divide(absent.filter(r=>!r.accepted).length,absent.length),noMatchPrecision:divide(absent.filter(r=>!r.accepted).length,rows.filter(r=>!r.accepted).length),
    unavailableCandidateAbstention:divide(noCandidate.filter(r=>!r.accepted).length,noCandidate.length),
    confusion:{acceptedCorrect:correct,acceptedWrong:accepted.length-correct,abstainedValid:valid.filter(r=>!r.accepted).length,abstainedNoMatch:absent.filter(r=>!r.accepted).length},
    calibration:{brier:divide(nonempty.reduce((s,r)=>s+(r.confidence-Number(r.correct))**2,0),nonempty.length),ece:divide(bins.reduce((s,b)=>s+b.count*Math.abs((b.accuracy??0)-(b.confidence??0)),0),nonempty.length),bins},
    proxy:{label:'Candidate inspection proxy, not human time. Inspect at most five suggestions; add one escalation step if truth is not visible. Denominator: all valid-match exceptions.',meanInspectionSteps:divide(inspected.reduce((a,b)=>a+b,0),inspected.length),topFiveSuccess:divide(valid.filter(r=>r.rank!==null&&r.rank<=5).length,valid.length),conditionalMeanRank:divide(valid.filter(r=>r.retrieved).reduce((s,r)=>s+r.rank!,0),valid.filter(r=>r.retrieved).length)},
  };
}
export type Metrics=ReturnType<typeof summarize>;
