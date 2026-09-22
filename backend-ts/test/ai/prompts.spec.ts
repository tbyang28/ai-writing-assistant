import { describe, expect, it } from 'vitest';

import {
  SYSTEM_PROMPTS,
  buildContextualChatPrompt,
  buildContinuePrompt,
  buildMessages,
} from '../../src/ai/prompts';

describe('SYSTEM_PROMPTS（逐字移植 ai_service.py）', () => {
  it('包含全部 8 个人格键', () => {
    expect(Object.keys(SYSTEM_PROMPTS).sort()).toEqual([
      'chat',
      'continue',
      'extract_characters',
      'fix',
      'improve',
      'outline',
      'polish_diff',
      'summarize',
    ]);
  });

  it('关键人格内容与 Python 版一致（抽查标志性句子）', () => {
    expect(SYSTEM_PROMPTS.continue).toContain('你是一个没有感情的码字机');
    expect(SYSTEM_PROMPTS.improve).toContain('你是一个没有感情的润色器');
    expect(SYSTEM_PROMPTS.fix).toContain('只输出校对后的小说正文');
    expect(SYSTEM_PROMPTS.extract_characters).toContain('"characters"');
    expect(SYSTEM_PROMPTS.outline).toContain('分章大纲');
  });
});

describe('buildMessages', () => {
  it('已知 key 使用对应 system 人格，user 内容在最后', () => {
    const messages = buildMessages('fix', '正文');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPTS.fix });
    expect(messages[1]).toEqual({ role: 'user', content: '正文' });
  });

  it('未知 key 回退 chat 人格', () => {
    const messages = buildMessages('不存在的命令', '正文');
    expect(messages[0].content).toBe(SYSTEM_PROMPTS.chat);
  });

  it('历史插在 system 与 user 之间，只保留最近 10 条', () => {
    const history = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `消息${i}`,
    }));
    const messages = buildMessages('chat', '最新问题', history);
    // system + 最近 10 条历史 + 当前 user
    expect(messages).toHaveLength(12);
    expect(messages.slice(1, 11).map((m) => m.content)).toEqual(
      history.slice(-10).map((m) => m.content),
    );
    expect(messages.at(-1)).toEqual({ role: 'user', content: '最新问题' });
  });

  it('历史里只接受 user/assistant 角色，其他角色跳过', () => {
    const messages = buildMessages('chat', '问题', [
      { role: 'system', content: '不该出现' },
      { role: 'user', content: '历史问题' },
      { role: 'tool', content: '也不该出现' },
      { role: 'assistant', content: '历史回答' },
    ]);
    expect(messages.filter((m) => m.role !== 'system').map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('content 缺省的历史消息按空串处理（Python 的 msg.get("content", "")）', () => {
    const messages = buildMessages('chat', '问题', [{ role: 'user' }]);
    expect(messages[1].content).toBe('');
  });
});

describe('buildContextualChatPrompt', () => {
  it('作品记忆在前，用户问题包在【用户问题】标题下', () => {
    const prompt = buildContextualChatPrompt('帮我写个开头', '【作品记忆】\n作品名：测试');
    expect(prompt).toBe('【作品记忆】\n作品名：测试\n\n【用户问题】\n帮我写个开头');
  });
});

describe('buildContinuePrompt', () => {
  it('有正文时给出【当前续写位置】与续写指令', () => {
    const prompt = buildContinuePrompt('  张三拔剑。 ', '记忆');
    expect(prompt).toContain('【续写任务】');
    expect(prompt).toContain('【当前续写位置】\n张三拔剑。');
    expect(prompt).toContain('延续最近前文中的情节因果');
  });

  it('正文为空时给默认引导语', () => {
    const prompt = buildContinuePrompt('   ', '记忆');
    expect(prompt).toContain('当前章节还没有正文，请根据前文章节自然开启下一章。');
  });

  it('正文按码点截断到 3000', () => {
    const content = '字'.repeat(3001);
    const prompt = buildContinuePrompt(content, '记忆');
    expect(prompt).toContain('字'.repeat(3000));
    expect(prompt).not.toContain('字'.repeat(3001));
  });
});
