import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { InputError, sha256 } from './engineering.mjs';

const manifestName = '归档清单.json';
const archiveDirectory = workspace => join(workspace, 'outputs', 'imported-analysis');

export const hasProjectArchive = workspace => existsSync(join(archiveDirectory(workspace), manifestName));
export const listProjectArchive = async workspace => JSON.parse(await readFile(join(archiveDirectory(workspace), manifestName), 'utf8'));

export async function readArchivedFile(workspace, record) {
  const parts = record.path.split('/');
  if (parts.some(part => !part || /[. ]$/.test(part) || /[\\:\x00-\x1f]/.test(part))) {
    throw new InputError('归档路径无效。');
  }
  const data = await readFile(join(archiveDirectory(workspace), ...parts));
  if (data.length !== record.size || sha256(data) !== record.digest) throw new InputError('归档文件与原登记不一致。', 409);
  return data;
}

export async function importProjectArchive(workspace, source, plan, references = []) {
  const root = resolve(source);
  const target = archiveDirectory(resolve(workspace));
  if (!(await lstat(root)).isDirectory()) throw new InputError('请选择本机分析文件夹。');

  async function inspect(folder, prefix = '') {
    const files = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) files.push(...await inspect(join(folder, entry.name), path + '/'));
      else if (entry.isFile()) files.push(path);
      else throw new InputError('分析目录含链接或特殊文件。');
    }
    return files;
  }

  const paths = (await inspect(root)).sort();
  if (!paths.includes(plan)) throw new InputError('分析目录中未找到指定的项目方案。');
  if (references.some(path => path === plan || !paths.includes(path))) throw new InputError('请指定分析目录中其余的参考文件。');
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.analysis-'));
  try {
    const files = [];
    for (const sourcePath of paths) {
      const role = sourcePath === plan ? 'plan' : 'generated';
      const path = `${role === 'plan' ? '交付物' : '生成物'}/${sourcePath}`;
      const data = await readFile(join(root, ...sourcePath.split('/')));
      const destination = join(staging, ...path.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data, { flag: 'wx' });
      files.push({ role, path, sourcePath, size: data.length, digest: sha256(data),
        ...(references.includes(sourcePath) ? { reference: true } : {}) });
    }
    const archive = { source: basename(root), importedAt: Date.now(), files };
    await writeFile(join(staging, manifestName), JSON.stringify(archive, null, 2), { flag: 'wx' });
    try {
      await rename(staging, target);
      return archive;
    } catch (error) {
      if (!hasProjectArchive(workspace)) throw error;
      const existing = await listProjectArchive(workspace);
      if (existing.source !== archive.source || JSON.stringify(existing.files) !== JSON.stringify(files)) {
        throw new InputError('项目已有内容不同的分析归档。', 409);
      }
      for (const file of existing.files) await readArchivedFile(workspace, file);
      return existing;
    }
  } finally {
    if (dirname(staging) === parent && basename(staging).startsWith('.analysis-')) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
