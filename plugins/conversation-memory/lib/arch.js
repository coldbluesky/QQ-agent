// 架构层门面：语义卡片 + 跨轮工作记忆 + 短时跨群感知。
// 本地为主，注入文本极短；可用配置整体关闭。
import path from 'node:path';
import { DATA_DIR } from './env.js';
import { SemanticCardStore } from './semantic-cards.js';
import { CrossTurnWorking } from './cross-turn.js';
import { buildCrossChatAwareness } from './cross-chat.js';
import { renderTodosForPrompt } from './pending.js';
import { shouldReduceOptionalInjects } from './cost-guard.js';

let facade = null;

export function getArchMemory() {
  if (facade) return facade;
  const cardsRoot = path.join(DATA_DIR, 'semantic-cards');
  const workRoot = path.join(DATA_DIR, 'cross-turn');
  const messagesDir = path.join(DATA_DIR, 'messages');
  facade = {
    cards: new SemanticCardStore(cardsRoot),
    working: null, // 随配置重建
    messagesDir,
    workRoot
  };
  return facade;
}

/** 按当前配置取工作记忆实例（TTL/长度可热更）。 */
export function getWorking(cfg) {
  const a = getArchMemory();
  const arch = cfg?.api?.architecture || {};
  const ttl = Number(arch.workingTtlMin) || 90;
  const maxChars = Number(arch.workingMaxChars) || 280;
  if (!a.working || a.working.ttlMs !== Math.max(5, ttl) * 60000) {
    a.working = new CrossTurnWorking(a.workRoot, { ttlMin: ttl, maxChars });
  }
  return a.working;
}

/** 是否启用某架构开关（默认开，除非显式 false）。 */
export function archOn(cfg, key) {
  const arch = cfg?.api?.architecture;
  if (!arch || typeof arch !== 'object') return true; // 默认开
  return arch[key] !== false;
}

/**
 * 组装架构注入片段（跨轮 + 语义卡片 + 跨群）。返回短字符串。
 */
export function buildArchitectureInject(cfg, { chatKey, kind, triggerText, botName = '', personIds = [] }) {
  if (!cfg?.api?.conversationMemory?.enabled) return '';
  const parts = [];
  const budgetCut = shouldReduceOptionalInjects(cfg);
  try {
    // 1) 待办（本地状态机；绑人的只在对方出现时注入）
    if (archOn(cfg, 'pendingTodos')) {
      const t = renderTodosForPrompt(chatKey, {
        max: budgetCut.reduce ? 1 : 3,
        personIds
      });
      if (t) parts.push(t);
    }
    // 2) 跨轮工作记忆（极短）
    if (archOn(cfg, 'crossTurnWorking')) {
      const w = getWorking(cfg).render(chatKey, { botName });
      if (w) parts.push(w);
    }
    // 3) 语义卡片（预算紧时跳过）
    if (archOn(cfg, 'semanticCards') && triggerText && !budgetCut.reduce) {
      const hits = getArchMemory().cards.match(triggerText, {
        chatKey: null,
        limit: Math.min(2, Number(cfg?.api?.architecture?.semanticTopN) || 2)
      });
      if (hits.length) {
        const lines = hits.map((h) => `- [${h.type}] ${h.title}`);
        parts.push(`【语义卡】${lines.join('；')}（当常识，别念时间戳）`);
      }
    }
    // 4) 短时跨会话旁听（预算紧时跳过）
    if (archOn(cfg, 'crossChatAwareness') && !budgetCut.reduce) {
      const arch = cfg?.api?.architecture || {};
      const s = buildCrossChatAwareness(
        getArchMemory().messagesDir,
        chatKey,
        {
          minutes: Number(arch.crossChatMinutes) || 12,
          maxChats: Math.min(2, Number(arch.crossChatMaxChats) || 2),
          maxChars: Math.min(200, Number(arch.crossChatMaxChars) || 180)
        }
      );
      if (s) parts.push(s);
    }
  } catch {
    /* 架构注入失败不影响主流程 */
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/** 运行结束后写入跨轮状态。 */
export function saveCrossTurn(cfg, chatKey, payload) {
  if (!archOn(cfg, 'crossTurnWorking')) return;
  try {
    getWorking(cfg).saveAfterRun(chatKey, payload);
  } catch { /* ignore */ }
}

/** 巩固小时块时顺带抽语义卡片。 */
export function ingestSemanticFromHour(chatKey, snippets) {
  try {
    return getArchMemory().cards.ingestHour(chatKey, snippets);
  } catch {
    return 0;
  }
}

export function archStats() {
  return getArchMemory().cards.stats();
}
