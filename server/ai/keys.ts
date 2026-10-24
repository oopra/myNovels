import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../paths';

/** API keys live in the OS keychain when keytar can load; otherwise in a 0600 file in the
 *  app config directory. Never in SQLite, never anywhere inside a novel folder. */
const SERVICE = 'novel-workbench';
type Keytar = { getPassword(s: string, a: string): Promise<string | null>; setPassword(s: string, a: string, p: string): Promise<void>; deletePassword(s: string, a: string): Promise<boolean> };

let keytar: Keytar | null | undefined;
async function loadKeytar(): Promise<Keytar | null> {
  if (keytar !== undefined) return keytar;
  try {
    const mod = await import('keytar');
    const k = (mod.default ?? mod) as Keytar;
    await k.getPassword(SERVICE, '__probe__');
    keytar = k;
  } catch { keytar = null; }
  return keytar;
}

const fileStore = () => path.join(configDir(), 'keys.json');
function readFile(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(fileStore(), 'utf8')); } catch { return {}; }
}
function writeFile(data: Record<string, string>): void {
  fs.writeFileSync(fileStore(), JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(fileStore(), 0o600);
}

const ENV: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };
/** In a cloud deployment keys arrive as secrets in the environment; those win over the stores. */
export function envKey(name: string): string | undefined {
  const v = process.env[ENV[name] ?? ''];
  return v && v.trim() ? v.trim() : undefined;
}

export async function keyStoreMode(): Promise<'keychain' | 'file'> {
  return (await loadKeytar()) ? 'keychain' : 'file';
}
export async function getKey(name: string): Promise<string | undefined> {
  const fromEnv = envKey(name);
  if (fromEnv) return fromEnv;
  const k = await loadKeytar();
  if (k) return (await k.getPassword(SERVICE, name)) ?? undefined;
  return readFile()[name];
}
export async function setKey(name: string, value: string): Promise<void> {
  const k = await loadKeytar();
  if (k) { if (value) await k.setPassword(SERVICE, name, value); else await k.deletePassword(SERVICE, name); return; }
  const data = readFile();
  if (value) data[name] = value; else delete data[name];
  writeFile(data);
}
