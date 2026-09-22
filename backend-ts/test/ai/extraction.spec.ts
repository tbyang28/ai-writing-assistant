import { describe, expect, it } from 'vitest';

import { parseCharacterExtraction } from '../../src/ai/extraction';

describe('parseCharacterExtraction', () => {
  it('解析干净的 JSON 输出', () => {
    const raw = JSON.stringify({
      characters: [
        { name: '张三', role: '主角', bio: '青云山弟子', confidence: 0.9 },
        { name: '李四', role: '反派', bio: '魔教教主', confidence: 0.8 },
      ],
    });
    expect(parseCharacterExtraction(raw)).toEqual([
      { name: '张三', role: '主角', bio: '青云山弟子', confidence: 0.9 },
      { name: '李四', role: '反派', bio: '魔教教主', confidence: 0.8 },
    ]);
  });

  it('剥掉 markdown 代码围栏（含 ```json 前缀）', () => {
    const raw = '```json\n{"characters": [{"name": "张三", "role": "主角"}]}\n```';
    expect(parseCharacterExtraction(raw)).toEqual([
      { name: '张三', role: '主角', bio: '', confidence: 0.7 },
    ]);
  });

  it('容忍 JSON 前后的杂文（取首尾花括号之间的片段）', () => {
    const raw = '好的，以下是识别结果：{"characters": [{"name": "张三"}]} 希望有帮助';
    expect(parseCharacterExtraction(raw)).toHaveLength(1);
  });

  it('缺省字段给默认值：role=未知、bio=空、confidence=0.7', () => {
    expect(parseCharacterExtraction('{"characters": [{"name": "无名"}]}')).toEqual([
      { name: '无名', role: '未知', bio: '', confidence: 0.7 },
    ]);
  });

  it('confidence 显式为 0 也保留（Python 的 item.get(...) or 0.7 对 0 会回退——保持一致）', () => {
    const parsed = parseCharacterExtraction('{"characters": [{"name": "甲", "confidence": 0}]}');
    expect(parsed[0].confidence).toBe(0.7);
  });

  it('按 name 去重', () => {
    const raw = JSON.stringify({
      characters: [
        { name: '张三', role: '主角' },
        { name: '张三', role: '配角' },
        { name: '李四', role: '反派' },
      ],
    });
    const parsed = parseCharacterExtraction(raw);
    expect(parsed.map((c) => c.name)).toEqual(['张三', '李四']);
  });

  it('name 超 30 字截断、bio 超 160 字截断（按码点）', () => {
    const raw = JSON.stringify({
      characters: [
        { name: '名'.repeat(35), role: '主角', bio: '传'.repeat(200) },
      ],
    });
    const [c] = parseCharacterExtraction(raw);
    expect(Array.from(c.name).length).toBe(30);
    expect(Array.from(c.bio).length).toBe(160);
  });

  it('最多保留 12 个人物', () => {
    const characters = Array.from({ length: 15 }, (_, i) => ({ name: `人物${i}` }));
    expect(parseCharacterExtraction(JSON.stringify({ characters }))).toHaveLength(12);
  });

  it('characters 不是数组或缺省 → 空结果', () => {
    expect(parseCharacterExtraction('{}')).toEqual([]);
    expect(parseCharacterExtraction('{"characters": "不是数组"}')).toEqual([]);
  });

  it('无法解析的输出抛 SyntaxError（控制器转 502）', () => {
    expect(() => parseCharacterExtraction('完全不是 JSON')).toThrow(SyntaxError);
    expect(() => parseCharacterExtraction('{"characters": [}')).toThrow(SyntaxError);
  });

  it('confidence 是非数值字符串时抛 TypeError（对齐 Python float() 报错→500）', () => {
    const raw = JSON.stringify({ characters: [{ name: '甲', confidence: '高' }] });
    expect(() => parseCharacterExtraction(raw)).toThrow(TypeError);
  });
});
