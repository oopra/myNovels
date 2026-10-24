import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Novel } from '../server/novel';
import { openNovelDb } from '../server/db';

export function tempNovel(): Novel {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-test-'));
  process.env.NOVEL_WORKBENCH_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-cfg-'));
  return new Novel(dir, openNovelDb(dir, true));
}
export const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
