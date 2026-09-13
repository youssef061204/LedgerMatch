import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseModel, type ModelBundle } from '../ml/model';

const cache = new Map<string, Promise<ModelBundle | null>>();
export async function loadRanker(enabled = process.env.ML_ENABLED !== 'false'): Promise<ModelBundle | null> {
  if (!enabled) return null;
  const filename=process.env.ML_MODEL_FILE??'ranker.json';
  if(!/^[a-zA-Z0-9_-]+\.json$/.test(filename)) { console.warn('Invalid ML_MODEL_FILE; using heuristic fallback.');return null; }
  const path = join(process.cwd(), 'models', filename);
  let loaded = cache.get(path);
  if (!loaded) {
    loaded = readFile(path, 'utf8').then(text => {
      if (text.length > 10 * 1024 * 1024) throw new Error('Model exceeds size limit');
      return parseModel(JSON.parse(text));
    }).catch(error => { console.warn(JSON.stringify({ event: 'ml_unavailable', message: error instanceof Error ? error.message : 'Invalid model', fallback: 'heuristic' })); return null; });
    cache.set(path, loaded);
  }
  return loaded;
}
