/** Fixed synthetic material, including the original seven-discipline case data. */
export const GROUPING_CONFIGS = [
  { positions: [60,100,140,180,220,260], colors: ['#2a9d4a','#d64545','#2a9d4a','#d64545','#2a9d4a','#d64545'], gapIndex: 3, gapRange: [40,160], initialGap: 40, threshold: 60 },
  { positions: [-20,0,40,60], colors: ['one','two','one','two'], gapIndex: 2, gapRange: [10,90], initialGap: 40, threshold: 25 },
] as const;
export const REACTION_CONFIGS = [
  { reactants: [{label:'H₂',coefficient:2,count:4,atoms:{H:2}}, {label:'O₂',coefficient:1,count:3,atoms:{O:2}}], products:[{label:'H₂O',coefficient:2,atoms:{H:2,O:1}}] },
  { reactants: [{label:'N₂',coefficient:1,count:3,atoms:{N:2}}, {label:'H₂',coefficient:3,count:7,atoms:{H:2}}], products:[{label:'NH₃',coefficient:2,atoms:{N:1,H:3}}] },
] as const;
