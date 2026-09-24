// 感知记忆：像感官输入 + 极短缓存。
// 原始消息进来先挂这里；几秒~几十秒后「丢掉」（不再单独保留原文指针），
// 由巩固器写入长时；工作层可从这里取「刚才发生了什么」。
import { randomUUID } from 'node:crypto';

export class SensoryBuffer {
  /** @param {number} ttlMs 默认 30s，之后视为已遗忘（从环形缓冲挤出） */
  constructor({ ttlMs = 30_000, capacity = 200 } = {}) {
    this.ttlMs = Math.max(1000, Number(ttlMs) || 30_000);
    this.capacity = Math.max(10, Number(capacity) || 200);
    /** @type {{id:string,at:number,chatKey:string,msg:object}[]} */
    this.items = [];
  }

  /** 感知一帧（收到/自发消息）。 */
  perceive(chatKey, msg) {
    const item = {
      id: randomUUID(),
      at: Date.now(),
      chatKey: String(chatKey || ''),
      msg: { ...msg }
    };
    this.items.push(item);
    this.#gc();
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    return item;
  }

  /** 仍「记得」的感知帧（未过 TTL）。 */
  alive({ chatKey = null } = {}) {
    this.#gc();
    return this.items.filter((x) => !chatKey || x.chatKey === chatKey);
  }

  /** 工作记忆用：最近 N 条仍存活的感知。 */
  recent(chatKey, limit = 20) {
    return this.alive({ chatKey }).slice(-Math.max(1, limit)).map((x) => x.msg);
  }

  #gc() {
    const now = Date.now();
    this.items = this.items.filter((x) => now - x.at <= this.ttlMs);
  }
}
