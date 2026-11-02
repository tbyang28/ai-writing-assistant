import { createHash } from 'node:crypto';

/** 同一资料的版本和码点范围；只在当前运行内去重，不缓存跨请求或跨写入的结果。 */
export interface ContextSource {
  id: string;
  version: string;
  start: number;
  end: number;
  text: string;
}

export function sourceVersion(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function uncoveredSources(sources: ContextSource[], covered: ContextSource[]): ContextSource[] {
  return sources.filter((source) => !covered.some((prior) => prior.id === source.id &&
    prior.version === source.version && prior.start <= source.start && prior.end >= source.end));
}
