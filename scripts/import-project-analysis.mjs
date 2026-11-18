import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEngineering } from '../electric-plugin/engineering.mjs';
import { importProjectArchive } from '../electric-plugin/project-archive.mjs';

const [projectName, source, plan, ...references] = process.argv.slice(2);
if (!projectName || !source || !plan) {
  throw new Error('用法：node scripts/import-project-analysis.mjs "项目名称" "分析目录" "主方案文件名" [参考文件名…]');
}

const home = resolve(process.env.AGENTS_ELECTRIC_HOME || fileURLToPath(new URL('../.local/dsh', import.meta.url)));
const store = openEngineering(home);
try {
  const projects = store.projects().filter(project => project.name === projectName);
  if (projects.length !== 1) throw new Error('请指定工作台中唯一的同名项目。');
  const project = projects[0];
  const archive = await importProjectArchive(store.workspace(project.id), source, plan, references);
  console.log(`已登记 ${project.name} 的分析归档，共 ${archive.files.length} 个文件。`);
} finally {
  store.close();
}
