import fs from 'node:fs/promises';
import path from 'node:path';
import {USER_STATE_FILES,deserializeMasteryTimelineState} from '../services/userStateService';
import {validateProfileRead} from '../services/profile/overviewRead';
import {projectLearningStatistics} from '../services/homepage/homepageViewModel';
import {statisticsDate,type LearningStatisticsSnapshot} from '../../apps/community-api/src/learningStatisticsContract';

/** Reads one captured library. No notes, profile classifications or daily records leave this reader. */
export async function readCommunityLearningStatistics(userStateDir:string,now=new Date()):Promise<LearningStatisticsSnapshot>{
  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base={asOfDate:statisticsDate(now,timeZone),timeZone,computedAt:now.toISOString(),calculationVersion:'loginote-learning-v1' as const};
  try{
    const file=path.join(userStateDir,USER_STATE_FILES.masteryTimeline),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error('Invalid timeline');
    const timeline=deserializeMasteryTimelineState(await fs.readFile(file,'utf8'));
    if(!timeline||!validateProfileRead('timeline',timeline))throw Error('Invalid timeline');
    if(!timeline.weeks.length)return {...base,state:'empty',values:{}};
    return {...base,state:'ready',values:projectLearningStatistics(timeline,base.asOfDate)};
  }catch(error){return {...base,state:(error as NodeJS.ErrnoException).code==='ENOENT'?'empty':'unavailable',values:{}};}
}
