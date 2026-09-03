/**
 * 正则推理用语统计的中间结构（纯前端确定性统计，零 AI 成本）。
 * density 字段均为「每千字次数」，未归一化。
 * 归一化到 0-1 由 analyzer 内部完成（公式：min(每千字次数/5, 1)，便于后期调整）。
 */
export interface ReasoningStyleStats {
  /** 因果/推导连接词密度（每千字）：因为/所以/因此/由于/从而/如果…那么/只要…就/除非…否则 */
  causalConnectorDensity: number;
  /** 举例标记密度（每千字）：比如/例如/譬如/举个例子/拿…来说 */
  exampleMarkerDensity: number;
  /** 类比标记密度（每千字）：就像/好比/相当于/类似/如同 */
  analogyMarkerDensity: number;
  /** 定义标记密度（每千字）：所谓/定义为/意思是/换句话说/也就是说 */
  definitionMarkerDensity: number;
  /** 0-1 结论前置比例：首句或段首出现结论标记（所以/因此/总之/总的来说/结论是）的比例 */
  conclusionFirstRatio: number;
  /** 模糊词密度（每千字）：那个/差不多/某种/大概/好像/似乎/也许 */
  vagueTermDensity: number;
  /** 绝对化词密度（每千字）：一定/必然/肯定/所有/全部/绝对/不可能/毫无疑问 */
  absolutistDensity: number;
}