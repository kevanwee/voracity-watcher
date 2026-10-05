import { localModel } from '../src/local-model.ts';
try {
  const model = localModel();
  console.log(`Local AI: ${model.model} at ${model.url}`);
} catch { console.error('Invalid local model settings. Use a loopback origin and valid model name.'); process.exitCode = 1; }
