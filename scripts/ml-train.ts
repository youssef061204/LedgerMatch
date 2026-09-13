import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
const local=process.platform==='win32'?'.local/ml-venv/Scripts/python.exe':'.local/ml-venv/bin/python';
const python=process.env.ML_PYTHON??(existsSync(local)?local:'python');
const child=spawn(python,['ml/train.py',...process.argv.slice(2)],{stdio:'inherit',shell:false});
child.on('error',error=>{console.error(`Cannot start training Python: ${error.message}. Install ml/requirements.txt in .local/ml-venv or set ML_PYTHON.`);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
