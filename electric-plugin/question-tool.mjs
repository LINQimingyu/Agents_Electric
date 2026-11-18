import { defineTool } from '@deepseek-ai/dsh-tools';
import { field } from './engineering.mjs';

export function registerQuestionTool(ctx, store) {
  function authorized(agent) {
    const parent = agent?.session.header.parentSession;
    const run = parent ? store.getRun(parent) : null;
    return Boolean(run && run.sessionId === parent &&
      (!run.runId || !store.getMilestones(run.runId).some(record => ['delivered', 'tested'].includes(record.kind))));
  }

  const tool = defineTool({
    name: 'request_engineering_clarification',
    description: '通过工作台向本次工程运行的操作者提问，等待文字答复。问题应涉及继续当前任务所必需的事实；实际改动和交付审批在工作流人工门禁处理。',
    parameters: { questions: {
      type: 'array', required: true, description: '一到三个简短具体的问题。',
      items: { type: 'string' },
    } },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!authorized(exec.agent)) throw new Error('该提问入口仅用于当前工程运行。');
      if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) {
        throw new Error('请提交一到三个具体问题。');
      }
      const questions = args.questions.map((question, index) => ({ id: String(index + 1), question: field(question, '问题', 800) }));
      exec.signal.throwIfAborted();
      const result = await ctx.serial('electric/workflow-question', { agent: exec.agent, signal: exec.signal, callId: exec.callId, questions });
      exec.signal.throwIfAborted();
      if (!result?.answers?.length) throw new Error('本次提问未收到答复。');
      return JSON.stringify(questions.map(question => ({ question: question.question,
        answer: result.answers.find(answer => answer.id === question.id)?.custom || '' })));
    },
  });
  return ctx.tools.register(tool, { when: ({ agent }) => authorized(agent) });
}
