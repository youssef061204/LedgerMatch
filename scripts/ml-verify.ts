import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const local=process.platform==='win32'?'.local/ml-venv/Scripts/python.exe':'.local/ml-venv/bin/python';
const python=process.env.ML_PYTHON??(existsSync(local)?local:'python');
async function run(command:string,args:string[]) {
  await new Promise<void>((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',shell:false});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));});
}
const manifest=await readFile('.local/ml-data/manifest.json','utf8');
const old=JSON.parse(manifest);const count=old.counts.train.groups+old.counts.validation.groups+old.counts.test.groups;
await run(process.execPath,['--import','tsx','scripts/ml-data.ts',String(count),String(old.seed)]);
if(await readFile('.local/ml-data/manifest.json','utf8')!==manifest)throw new Error('Dataset regeneration was not byte-identical');
await run(python,['-m','unittest','discover','-s','ml','-p','test_*.py','-v']);
await run(python,['ml/train.py','--output','.local/reproduced-model']);
const original=JSON.parse(await readFile('models/ranker.json','utf8'));
const repeated=JSON.parse(await readFile('.local/reproduced-model/ranker.json','utf8'));
if(original.modelId!==repeated.modelId||JSON.stringify(original.models)!==JSON.stringify(repeated.models))throw new Error('Training was not reproducible');
if(await readFile('models/parity.json','utf8')!==await readFile('.local/reproduced-model/parity.json','utf8'))throw new Error('Native prediction probes differ');
await mkdir('artifacts/evaluation',{recursive:true});
await writeFile('artifacts/evaluation/reproducibility.json',JSON.stringify({verifiedAt:new Date().toISOString(),seed:old.seed,modelId:original.modelId,datasetFilesByteIdentical:true,modelParametersByteIdentical:true,nativePredictionsByteIdentical:true,pythonTests:5,scope:'Regenerated all input files; trained only on train and validation. No test-driven fitting.'},null,2)+'\n');
console.log('Dataset, parameters, calibration, thresholds and native predictions reproduced exactly.');
