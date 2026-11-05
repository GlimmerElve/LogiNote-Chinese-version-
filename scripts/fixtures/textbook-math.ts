/** Authored, independent acceptance lesson. No remote model call or user-vault material. */
import type { TeachingBlueprint, TextbookChapter, TextbookSource } from '../../src/services/textbook/generationTypes';
import type { TextbookFunctionPlot } from '../../src/services/textbook/functionPlot';
export const functionFence = (plot: TextbookFunctionPlot) => '```function-plot\n' + JSON.stringify(plot) + '\n```';
export const parabolaPlot: TextbookFunctionPlot = {
  title: '看见函数：同一个 x 对应一个 y', variable: 'x', xLabel: 'x（自变量）', yLabel: 'y（函数值）',
  xDomain: [-2.3, 2.3], yDomain: [-.7, 5.5], curves: [{ id: 'f', label: '抛物线', expression: 'x^2' }],
};
export const riemannPlot: TextbookFunctionPlot = {
  ...parabolaPlot, title: '用小矩形逼近曲线下的面积', xDomain: [-.25, 2.3], yDomain: [-.6, 5.2],
  area: { curveId: 'f', from: 0, to: 2 }, riemann: { curveId: 'f', from: 0, to: 2, count: 8, method: 'midpoint' },
};
export const signedPlot: TextbookFunctionPlot = {
  title: '同一张图：有向积分为零，几何面积不为零', variable: 'x', xLabel: 'x（自变量）', yLabel: 'y = x',
  xDomain: [-1.3, 1.3], yDomain: [-1.4, 1.4], curves: [{ id: 'f', label: '线性函数', expression: 'x' }],
  area: { curveId: 'f', from: -1, to: 1 }, riemann: { curveId: 'f', from: -1, to: 1, count: 8, method: 'midpoint' },
};
export const mathBlueprint: TeachingBlueprint = {
  title: '从函数到面积：看懂定积分',
  objectives: [{ id: 'O1', text: '在表达式、表格与图像之间辨认自变量和函数值。' },
    { id: 'O2', text: '解释黎曼矩形的宽、高、取样点，并用极限连接近似与定积分。' },
    { id: 'O3', text: '区分有向积分与几何面积，完成一个变号函数的面积计算。' }], focuses: [],
  chapters: [
    { id: 'ch1', title: '先读函数，再读图像', objectiveIds: ['O1'], focusIds: [], sourceIds: ['N1'], bridge: '先理解一个输入怎样决定一个输出，再讨论整段区间上的累积。', visuals: [{ format: 'function-plot', section: 'explanation', purpose: '连接输入输出表和连续曲线。', readingQuestion: '图上高度是函数值，还是面积？' }] },
    { id: 'ch2', title: '把弯曲区域拆成小矩形', objectiveIds: ['O2'], focusIds: [], sourceIds: ['N1'], bridge: '知道如何读出曲线高度之后，用这些高度构造可计算的小面积，再走向精确累积。', visuals: [{ format: 'function-plot', section: 'workedExample', purpose: '调节分割数观察黎曼和的变化。', readingQuestion: '小矩形怎样逼近弯曲边界？' }] },
    { id: 'ch3', title: '面积不会抵消，积分可以', objectiveIds: ['O3'], focusIds: [], sourceIds: ['N1'], bridge: '上一章的函数非负；现在让曲线穿过横轴，看清“有向累积”和“占据面积”的区别。', visuals: [{ format: 'function-plot', section: 'workedExample', purpose: '对照正负区域与两个累积结果。', readingQuestion: '为什么积分为零不代表没有面积？' }] },
  ],
};
export const mathSourceText = String.raw`本例是编写的独立教学说明，不是上传的原始教材或模型检索结果。
函数 y=x² 中 x 为自变量，y 为函数值。区间[0,2]上平方函数连续且非负。分割为n段时 Δx=2/n；左、右端点和中点的函数值乘以段宽，得到矩形的有向面积，求和得到黎曼和。连续函数的黎曼和在分割趋细时收敛到定积分；非负函数时定积分等于曲线与横轴围成的面积。x²在[0,2]的定积分为8/3。中点n=4时和为2.625。对于递增函数，左端点和不超过积分，右端点和不小于积分。函数x在[-1,1]的有向积分为0，几何面积为1；几何面积是|f(x)|的积分。在零点分段可分别计算正负区域。微分dy=f'(x)dx描述局部线性变化，不等同于一个有限黎曼矩形的面积。
阅读依据：OpenStax Calculus Volume 1，5.1 Approximating Areas、5.2 The Definite Integral；本例的平方函数/线性函数数值与练习由编者计算。`;
export const mathSources: TextbookSource[] = [{ sourceId: 'N1', kind: 'knowledge', id: 'math-demo-source', title: '数学示例教学说明（编写示例，非检索原文）', version: 'math-demo-v1', text: mathSourceText }];
export const mathChapters: TextbookChapter[] = [
  { id: 'ch1', sections: {
    explanation: String.raw`假设你把一个数送进“平方”的规则：输入 1，输出 1；输入 2，输出 4。把这条规则写成 $y=f(x)=x^2$，其中 $x$ 是可以改变的输入，$y$ 是随之确定的函数值。[N1]

| 输入 $x$ | -2 | -1 | 0 | 1 | 2 |
| --- | --- | --- | --- | --- | --- |
| 输出 $y=x^2$ | 4 | 1 | 0 | 1 | 4 |

观察问题：$x$ 从 0 走到 2，曲线高度怎样变化？同样的高度是否可能对应两个输入？

` + functionFence(parabolaPlot) + String.raw`

读图要点：图上的点 $(1,1)$ 表示输入 1 对应输出 1，不是“面积等于 1”。左右两侧可有相同高度，但每一个输入仍只有一个输出；请在表格和曲线中各找一组这样的点。[N1]`,
    boundaries: String.raw`本课只画单一自变量的显式函数。绘图区间只是当前观察窗口，不一定是函数的全部定义域；例如 $x^2$ 在所有实数上都有意义，而图中只显示有限一段。[N1]

不要仅凭图形外观判断精确数值，也不要把图像渲染成功当成公式已被证明。`,
    workedExample: String.raw`比较“曲线在 $x=2$ 的高度”和“$0$ 到 $2$ 之间曲线下面积”。前者只需代入：$f(2)=4$；后者涉及整段区间，不能用末端高度直接代替。[N1]

反例：若把宽为 2、高为 4 的整块矩形当作曲线下的面积，会得到 8，但曲线除末端外都低于这块矩形的顶边。这个矩形只能提供粗略的上界，不是精确面积。`,
    practice: String.raw`仍取 $y=x^2$。写出 $x=-1.5$ 与 $x=1.5$ 的函数值，再回答：两个输入得到同一输出，是否违反函数的定义？请用“每个输入”解释，而不是只看图像对称。`,
    answer: String.raw`两者的函数值都是 $2.25$。不违反定义，因为函数要求每一个输入恰好对应一个输出，而不是要求不同输入必须得到不同输出；这里的每个输入仍得到唯一的平方值。[N1]`,
    selfCheck: '1. 我能在表格、公式、图像中指认同一个点。\n2. 我能区分函数值与一段区间上的面积。\n3. 我不会把观察窗口当作函数的全部定义域。',
    summary: String.raw`函数图把“输入—输出”变成位置与高度。接下来保留每个小区间上的高度信息，用可计算的矩形来逼近整个弯曲区域。`,
  } },
  { id: 'ch2', sections: {
    explanation: String.raw`要求 $y=x^2$ 在 $[0,2]$ 上的曲线下面积，难点是上边界弯曲。先不追求一步算准：把底边分成 $n$ 段，在每段选一个点，用该点的函数值作为矩形高度，然后把所有矩形加起来。[N1]

$$
\Delta x=\frac{2}{n},\qquad x_i^*=\left(i-\frac12\right)\Delta x,\qquad M_n=\sum_{i=1}^{n} f(x_i^*)\,\Delta x.
$$

这里 $n$ 是分割数，$\Delta x$ 是一段的宽度，$x_i^*$ 是第 $i$ 段的中点，$f(x_i^*)$ 是它的高度。星号只是“选定取样点”的记号，不是乘号。高度乘宽度给出这一小块的面积。[^width]`,
    boundaries: String.raw`有限个矩形得到近似值；对本课的连续函数，当分割越来越细时，黎曼和收敛到定积分。非负条件保证这里的有向累积同时是几何面积。[N1]

` + '```textbook-tip\n' + JSON.stringify({ title: 'Δx、dx 与 dy 不要混用', kind: 'warning', text: String.raw`矩形宽度 $\Delta x$ 是有限小区间；积分中的 $dx$ 标明积分变量，不能把每个有限矩形称为“精确微分柱”。微分 $dy=f'(x)dx$ 描述局部线性变化，是另一个视角。[N1]` }) + '\n```',
    workedExample: String.raw`先固定中点取样，尝试把分割数从 4 调到 8、16、32。观察黄色矩形怎样贴近绿色曲线，同时观察下方近似数值；再切到左端点和右端点比较。[N1]

` + functionFence(riemannPlot) + String.raw`

对照计算：当 $n=4$，宽度为 $0.5$，取样点为 $0.25,0.75,1.25,1.75$。

$$
\begin{aligned}
M_4&=0.5(0.25^2+0.75^2+1.25^2+1.75^2)\\
&=2.625.
\end{aligned}
$$

精确值来自定积分。$F(x)=x^3/3$ 的导数是 $x^2$，因此由微积分基本定理：

$$
A=\int_0^2 x^2\,dx=\left[\frac{x^3}{3}\right]_0^2=\frac83\approx2.666667.
$$

这一步不是“矩形图自动证明了积分”；图展示逼近过程，原函数与定理给出精确结果。中点矩形有些部分多盖、有些部分少盖，所以不能把单个矩形的情况直接当成总误差判断。对于这条在 $[0,2]$ 递增的曲线，左端点和低估、右端点和高估。[N1]`,
    practice: String.raw`改用右端点，把 $[0,2]$ 分为两段。先写出宽度，再写两个高度，求 $R_2$，并判断它与 $8/3$ 的大小关系。解释时指出函数在这个区间上的变化，而不是把“右端点总会高估”推广到所有函数。`,
    answer: String.raw`$\Delta x=1$，两个右端点为 1 和 2，高度为 1 和 4，因此 $R_2=1\cdot1+4\cdot1=5\gt8/3$。平方函数在 $[0,2]$ 单调递增，每段右端点高度不低于该段其它点的高度，因而这里高估。递减函数的结论相反，不能仅凭取样名称下判断。[N1]`,
    selfCheck: '1. 我能说清每个矩形的宽、高、取样点。\n2. 我能分别解释有限和、极限、精确积分。\n3. 我能用单调性解释本例左、右端点估计的方向。',
    summary: String.raw`先把面积拆成 $f(x_i^*)\Delta x$，再让分割趋细，这就是从可计算近似通向定积分的路径。下一章取消函数非负的条件，检查“面积”这一解释还能否直接使用。

[^width]: 这里的横、纵坐标按无量纲数值处理；若横轴单位为秒、纵轴单位为米每秒，则高度乘宽度的单位为米，而不是平方米。`,
  } },
  { id: 'ch3', sections: {
    explanation: String.raw`想象曲线穿过横轴：有些矩形的高度为正，有些为负。黎曼和保留这个符号，因此定积分描述“正的贡献减去负的贡献”；几何面积却不能为负，两者不能混为一谈。[N1]

$$
I=\int_a^b f(x)\,dx,\qquad A_{\mathrm{geom}}=\int_a^b |f(x)|\,dx.
$$

若用速度举例，前者对应位移，后者对应路程；这个类比是在已明确速度可正可负、对时间积分的条件下成立，不是说任何纵轴都表示速度。`,
    boundaries: String.raw`当函数全程非负时，定积分等于几何面积；全程非正时，定积分是几何面积的相反数。变号时应找零点，把积分区间分段，或对绝对值函数积分。[N1]

还要区分 $\left|\int f\right|$ 与 $\int|f|$：先抵消再取绝对值，一般不能恢复已被抵消的面积。`,
    workedExample: String.raw`观察问题：$y=x$ 在 $[-1,1]$ 上的左右两块阴影大小相同，为什么页面会同时显示“有向和接近 0”和“几何面积之和接近 1”？[N1]

` + functionFence(signedPlot) + String.raw`

左右两块区域都是底和高为 1 的三角形，每块几何面积为 $1/2$。但左半边函数为负，所以：

$$
\begin{aligned}
I&=\int_{-1}^{1}x\,dx=\left[\frac{x^2}{2}\right]_{-1}^{1}=0,\\
A_{\mathrm{geom}}&=-\int_{-1}^{0}x\,dx+\int_0^1x\,dx=\frac12+\frac12=1.
\end{aligned}
$$

请指着左半边说出：几何面积是正的 $1/2$，对有向积分的贡献是负的 $-1/2$。中点取样在这个对称线性示例中恰好算准，并不意味着任何函数、任何有限分割都能精确。[N1]`,
    practice: String.raw`取 $f(x)=x-1$，区间为 $[0,2]$。请找出零点，分别计算定积分与几何面积，再解释为什么“把定积分结果取绝对值”会出错。先自己分段，之后展开答案。`,
    answer: String.raw`零点为 $x=1$。$[0,1]$ 上函数非正，$[1,2]$ 上非负。原函数为 $x^2/2-x$，故定积分为 0。左右两个三角形各有 $1/2$ 的几何面积，合计为 1；对有向积分的贡献分别为 $-1/2$ 和 $1/2$。$|0|=0$ 已经丢失抵消前的大小，不能代替几何面积。[N1]`,
    selfCheck: '1. 我能在图中分清正、负区域。\n2. 我知道积分为零不等于几何面积为零。\n3. 我能找零点分段，并选择保留符号还是取绝对值。',
    summary: String.raw`一条完整的解题路线是：先认变量与区间，再认函数正负，随后决定求有向积分还是几何面积，最后计算并用图形检查量级。

` + '```mermaid\nflowchart LR\nV1["确定函数与区间"] --> V2["检查零点与正负"]\nV2 --> V3{"要算什么？"}\nV3 --> V4["有向累积：保留符号"]\nV3 --> V5["几何面积：分段取正"]\nV4 --> V6["计算并核对图形"]\nV5 --> V6\n```',
  } },
];
