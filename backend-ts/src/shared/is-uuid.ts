/**
 * 是否为合法 UUID —— Python 侧 book_id 等参数是裸 str，
 * 非 UUID 串查库必空 → 404；Postgres 遇到非法 uuid 字面量却会直接报错（→500）。
 * 管道 / 控制器 body 校验 / story-memory 取章节统一走这里。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
