import { ARGUMENT_RELATION_CLASSIFY_PROMPT } from './argumentRelationClassifyPrompt.ts';

/** Versioned experiment only. Keep v1 frozen for comparable reruns. */
export const ARGUMENT_RELATION_DIRECTION_PROMPT = `${ARGUMENT_RELATION_CLASSIFY_PROMPT}

显式方向契约（在上述每项输出中增加 directionCheck）：
1. sourceSentenceIds 和 targetSentenceIds 的角色由输入指定，不是让你任意选择方向。先明确哪端是理由，哪端是得到支持或被反驳的主张，再判断这是不是输入要求的方向。
2. 如果只能发现 target 支持 source，不得返回输入方向的 support。可判 insufficient_evidence，不得交换端点后假装完成原题。
3. 如果返回 support/oppose，必须增加：
"directionCheck":{"direction":"source_to_target|target_to_source|undetermined","basisSentenceIds":["真正作为理由的端点全部句子ID"],"conclusionSentenceIds":["真正得到支持或被反驳的端点全部句子ID"],"premiseStatus":"sufficient|missing"}。
其中 basis/conclusion 只能回填两个既定端点之一的完整 ID 集合，不含额外上下文；必要上下文证据放 evidenceSentenceIds。direction 必须与真正使用的理由和结论角色一致。
4. 用一句话检查：仅有 source 的信息与显式上下文，是否仍有理由接受或削弱 target？不得反过来读取 target 的具体细节后用它证明 source，再把这条反方向关系填入当前题目。
5. 合法的反驳有时双向都成立，不得机械认为反转端点就必须拒绝；仍须逐对判断。建议也可由问题或收益提供理由，不要求达到数学演绎证明。
6. 非论证标签 directionCheck 返回 null。没有正确回填方向字段的支持/反对结果不能准入。
`;
