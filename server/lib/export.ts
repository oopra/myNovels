import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store } from '../store';

const run = promisify(execFile);

/** Export the manuscript, bible and owed list as markdown and commit. Needs no network and no key. */
export async function exportNovel(store: Store, novelFolder: string, title: string): Promise<{ dir: string; files: string[]; commit: string | null; gitError?: string; pushed?: boolean }> {
  const dir = store.getSetting('export.path') || path.join(novelFolder, 'manuscript');
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bible'), { recursive: true });
  const files: string[] = [];
  // Remove stale chapter files so renumbering does not leave ghosts behind.
  for (const f of fs.readdirSync(path.join(dir, 'chapters'))) if (f.endsWith('.md')) fs.unlinkSync(path.join(dir, 'chapters', f));
  for (const c of store.listChapters()) {
    const name = `chapters/${String(c.number).padStart(2, '0')}-${c.slug}.md`;
    const fm = `---\nnumber: ${c.number}\ntitle: ${JSON.stringify(c.title)}\nstatus: ${c.status}\nwords: ${c.word_count}\nupdated: ${c.updated_at}\n---\n\n`;
    fs.writeFileSync(path.join(dir, name), fm + c.body.replace(/\s*$/, '\n'));
    files.push(name);
  }
  for (const f of fs.readdirSync(path.join(dir, 'bible'))) if (f.endsWith('.md')) fs.unlinkSync(path.join(dir, 'bible', f));
  for (const p of store.listBible()) {
    const name = `bible/${p.kind}-${p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
    fs.writeFileSync(path.join(dir, name), `# ${p.title}\n\n${p.body.replace(/\s*$/, '\n')}`);
    files.push(name);
  }
  const inputs = store.listInputs();
  const lines = ['# Inputs', ''];
  for (const status of ['inbox', 'planned', 'placed', 'dropped'] as const) {
    const group = inputs.filter(i => i.status === status);
    lines.push(`## ${status[0].toUpperCase() + status.slice(1)} (${group.length})`, '');
    for (const i of group) {
      const target = i.target_chapter_id ? ` → chapter ${store.getChapter(i.target_chapter_id)?.number ?? '?'}` : '';
      lines.push(`- **${i.title}** _${i.kind}_${target}${i.source ? ` (${i.source})` : ''}`);
      if (i.body.trim()) lines.push(`  ${i.body.trim().replace(/\n/g, '\n  ')}`);
      for (const l of i.links ?? []) lines.push(`  - placed at: “${l.anchor_text}” (version ${l.version_id})`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, 'inputs.md'), lines.join('\n'));
  files.push('inputs.md');
  const chapters = store.listChapters();
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${title}\n\nExported by Novel Workbench.\n\n${chapters.map(c => `${c.number}. ${c.title} (${c.status}, ${c.word_count} words)`).join('\n')}\n`);
  files.push('README.md');

  let commit: string | null = null; let gitError: string | undefined;
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) await run('git', ['init', '-q'], { cwd: dir });
    await run('git', ['add', '-A'], { cwd: dir });
    const status = await run('git', ['status', '--porcelain'], { cwd: dir });
    if (status.stdout.trim()) {
      await run('git', ['-c', 'user.name=Novel Workbench', '-c', 'user.email=workbench@localhost', 'commit', '-q', '-m', `Export ${new Date().toISOString()}`], { cwd: dir });
    }
    commit = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim();
  } catch (e) { gitError = (e as Error).message; }
  let pushed: boolean | undefined;
  const remote = store.getSetting('export.remote');
  if (remote && commit) {
    try {
      const existing = await run('git', ['remote'], { cwd: dir });
      if (!existing.stdout.split('\n').includes('origin')) await run('git', ['remote', 'add', 'origin', remote], { cwd: dir });
      else await run('git', ['remote', 'set-url', 'origin', remote], { cwd: dir });
      const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim();
      await run('git', ['push', '-u', 'origin', branch], { cwd: dir, timeout: 60_000 });
      pushed = true;
    } catch (e) { pushed = false; gitError = `push failed: ${(e as Error).message.split('\n').find(l => /fatal|error|remote:/.test(l)) ?? (e as Error).message}`; }
  }
  return { dir, files, commit, gitError, pushed };
}
