export const UNIFIED_NARRATIVE_GRAPH_VERSION = 'narrative-unified-uses-v1' as const;
export const UNIFIED_NARRATIVE_GRAPH_PROMPT = `把提供的论证链摘要重建成核心论证图，不重新抽取全文，不补事实，不为连通造边。保留真正必要的理由、中间判断、被回应的预期及条件和限制，不追求每句话都变节点。

先分清被论证的命题内容与说话归属：text写独立完整的判断；“谁提出、在什么假设下预期”放scope，不揉成“某人说过这句话”的命题。需要讨论言说事实本身时才scope.level=attribution，否则为content。实际结果可以反驳预期内容，但不因此反驳谁曾提出该预期。必要的预期、实际结果、作者回应分别成节点；同一判断定义一次、复用id。

所有材料对目标的用途只写在links这一个列表：premises是材料节点ID数组，target是被作用的命题ID，use从以下选择。
supports：理由支持目标内容；rebuts：反证削弱目标内容，不是支持“目标被反驳”这一新说法。
limits：保留证据强度、范围或非唯一性；condition：目标成立或适用所需前提。这两类不是支持/反驳，不另写附注列表。
none：无此直接作用；uncertain：摘要不足以确定作用。不必枚举所有无关节点对。
联合理由放同一premises，独立理由分组；保留必要中间推断并回接，不将所有同主题材料混成联合理由。对象、结果、条件不匹配不能直接连接。同一材料可以用于不同目标，但不把同一用途重复输出到不同位置。
研究缺陷不自动否定机制，其他可能解释不否定一个非唯一机制，未复现不反驳本来就保留不确定性的判断。区分预测变量彼此相关与各自对结果的贡献：控制后仍有效应不能推出两预测变量是零相关、非零相关或某一相关方向；有直接相关报告才按该报告判断。不把可能解释升级为已证实机制。

只输出JSON：{"statements":[{"id":"P1","text":"判断内容","sourcePassageIds":["摘要段落id"]}],"links":[{"premises":["材料节点id"],"target":"判断节点id","use":"supports或rebuts或limits或condition或none或uncertain"}],"coreIds":["已定义的P命题id"],"unresolved":[]}。
links的所有端点和coreIds必须引用statements已定义的ID，不填说明文字，不新建C编号。易混淆的节点可加scope:{"level":"content或attribution","speaker":"归属者","condition":"必要假设或适用条件"}，condition可省略；不强制给所有节点加scope。
上限60命题、30条links、12个核心回应、20条未决说明；不要为了凑数量省略必要分支。sourcePassageIds仅定位摘要段落，不冒充论文原文证据。只输出上述字段，不输出思考过程。`;
