import { defineTool } from '@deepseek-ai/dsh-tools';
import { decodeCsv, programFiles } from './engineering.mjs';

export function registerProgramTool(ctx, store) {
  function authorizedPrograms(agent) {
    const parent = agent?.session.header.parentSession;
    const run = parent ? store.getRun(parent) : null;
    return run && run.sessionId === parent ? programFiles(store.runProject(run)) : [];
  }

  const tool = defineTool({
    name: 'plc_csv',
    description: '只读查询本次运行的原始程序 CSV。检索时关键词可跨所有程序段查询；读取或引用时使用清单中的相对路径和从 1 开始的原始物理行号。',
    parameters: {
      path: { type: 'string', description: '清单中的文件相对路径。跨文件检索可省略。' },
      startLine: { type: 'integer', description: '读取起始行号。' },
      lineCount: { type: 'integer', description: '读取行数，最多 80 行。' },
      query: { type: 'string', description: '检索一个指令、地址或注释关键词。省略则按行号读取。' },
    },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      const programs = authorizedPrograms(exec.agent);
      const files = args.path ? programs.filter(file => file.path === args.path) : programs;
      if (!files.length) throw new Error('该文件未登记在本次运行。');
      const query = typeof args.query === 'string' ? args.query.trim().slice(0, 160).toUpperCase() : '';
      if (!query && !args.path) throw new Error('按行读取时须指定清单中的文件。');
      const start = Number.isSafeInteger(args.startLine) ? Math.max(1, args.startLine) : 1;
      const count = Number.isSafeInteger(args.lineCount) ? Math.max(1, Math.min(80, args.lineCount)) : 30;
      const matches = [];
      let budget = 12000;
      for (const file of files) {
        const rows = decodeCsv(store.readFile(file.digest)).value.split(/\r\n|\n|\r/);
        const end = query ? rows.length : Math.min(rows.length, start - 1 + count);
        for (let index = start - 1; index < end; index++) {
          const text = rows[index];
          if (query && !text.toUpperCase().includes(query)) continue;
          const line = text.slice(0, Math.min(2000, budget));
          matches.push({ file: file.path, line: index + 1, text: line, ...(line.length < text.length ? { truncated: true } : {}) });
          budget -= line.length + 60 + file.path.length;
          if (budget <= 0 || query && matches.length >= 40) {
            return JSON.stringify({ matches, limited: true, continueAt: { path: file.path, startLine: index + 2 } });
          }
        }
      }
      return JSON.stringify({ matches, limited: false });
    },
  });
  return ctx.tools.register(tool, { when: ({ agent }) => authorizedPrograms(agent).length > 0 });
}
