import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

copyFileSync(
  resolve('src', 'worklet', 'tera-pcm-processor.js'),
  resolve('dist', 'tera-pcm-processor.js'),
);
