import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { generateSample, GENERATOR_VERSION, SCENARIOS, WITHHELD_SCENARIOS, assertSplitIsolation, type Sample } from '../src/ml/dataset';
import { FEATURE_NAMES, FEATURE_VERSION } from '../src/ml/features';

const count = Number(process.argv[2] ?? 30000), seed = Number(process.argv[3] ?? 20260913);
if (!Number.isInteger(count) || count < 300 || count > 100000 || count % 300 !== 0 || !Number.isSafeInteger(seed)) throw new Error('Use a multiple of 300 groups (300..100000) and an integer seed.');
const dir = '.local/ml-data'; await mkdir(dir, { recursive: true });
const splitNames = ['train', 'validation', 'test', 'robustness'] as const;
const streams = Object.fromEntries(splitNames.map(s => [s, createWriteStream(`${dir}/${s}.jsonl`)]));
const counts: Record<string, { groups: number; exceptions: number; pairs: number; deterministic: number }> = {};
const fingerprints: Sample[] = [];
for (const robustness of [false, true]) {
  const size = robustness ? count / 10 : count;
  for (let n = 0; n < size; n++) {
    const sample = generateSample(Math.floor(n / 10), n % 10, seed, robustness);
    const stats = counts[sample.split] ??= { groups: 0, exceptions: 0, pairs: 0, deterministic: 0 };
    stats.groups++; stats.pairs += sample.x.length; stats[sample.route === 'exception' ? 'exceptions' : 'deterministic']++;
    fingerprints.push({ ...sample, x: [], candidates: [], y: [] });
    if (!streams[sample.split].write(JSON.stringify(sample) + '\n')) await once(streams[sample.split], 'drain');
  }
}
assertSplitIsolation(fingerprints);
await Promise.all(Object.values(streams).map(async s => { s.end(); await once(s, 'finish'); }));
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const sourceFiles = ['src/ml/features.ts', 'src/ml/dataset.ts', 'src/domain/matching.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async p => [p, sha(await readFile(p))])));
const files = Object.fromEntries(await Promise.all(splitNames.map(async p => [p, sha(await readFile(`${dir}/${p}.jsonl`))])));
const manifest = { generatorVersion: GENERATOR_VERSION, featureVersion: FEATURE_VERSION, features: FEATURE_NAMES, seed, counts, sourceHashes, files, scenarios: SCENARIOS, withheldScenarios: WITHHELD_SCENARIOS,
  split: 'Whole cohorts of ten cases; 60/20/20 train/validation/test; validation cohorts further partitioned into selection/calibration/threshold; independent robustness cohorts.' };
await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ counts, seed, generatorVersion: GENERATOR_VERSION }));
