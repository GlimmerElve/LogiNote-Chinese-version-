/** Prompt-only endpoint binding experiment. Frozen schema/parser/gate are unchanged. */
import { AUTHOR_USE_EVIDENCE_FIRST_PROMPT, prepareEvidenceFirstUseProbe } from './authorUseEvidenceFirstProbe';
import type { AuditInput } from './relationAuditShadow';

export const AUTHOR_USE_BOUND_VERSION = 'author-use-bound-v1';
export const AUTHOR_USE_BINDING_INSTRUCTION = `用途定位后，按固定端点核对：每个YES都应确认作者使用的是当前premises中的材料，并将其用于当前完整target。引文只是出现或复述目标、前提和目标同段出现、或谈到同一问题，都不能代替这个用途绑定；也不把引文中其他节点的内容自动并入当前前提组。允许跨段回指和语义一致的改述，不要求逐字重复；不要求每个前提独立充分，作者明确使用的弱论证仍保留。
target必须保持其对象、条件、范围及整句含义，不能换成其前件、上游假说或更宽的观点。反驳某个假说，不自动等于反驳以该假说为前件的整个条件命题；分别按当前端点与原文用途回答。
用一种解释说明现象，不自动反向证明该解释成立；只有作者确实另用观测为该具体解释提供理由，才有反向支持。同一论述中的相容保留意见不自动相互支持或限制。reason简短说明当前前提对当前目标的实际用途，不用“目标在原文中出现”代替关系依据；找不到确定用途仍按原四问规则区分NO与UNCERTAIN，不新增验证门或现实充分性判断。`;

const marker = '\nestablish：';
if (AUTHOR_USE_EVIDENCE_FIRST_PROMPT.split(marker).length !== 2) throw new Error('Frozen evidence-first prompt layout changed; binding experiment needs review');
export const AUTHOR_USE_BOUND_PROMPT = AUTHOR_USE_EVIDENCE_FIRST_PROMPT.replace(marker, `\n${AUTHOR_USE_BINDING_INSTRUCTION}${marker}`);
export function prepareBoundUseProbe(input: AuditInput) {
  return { ...prepareEvidenceFirstUseProbe(input), version: AUTHOR_USE_BOUND_VERSION, systemPrompt: AUTHOR_USE_BOUND_PROMPT };
}
