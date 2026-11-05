import { allGroups, allResources, type CommunityComment, type DemoState, type Person, type StudyGroup } from './model';

export type DiscussionPost = {id:string; author:Person; title?:string; body:string; bodyFormat?:'markdown'; type?:'discovery'|'question'; topic?:string; topicIds?:string[]; resourceId?:string; groupId?:string};
/** Keep the original thread IDs so existing replies and drafts remain readable. */
export function groupQuestion(group:StudyGroup):DiscussionPost {
  return {
    id:`group-question:${group.id}`,author:group.creator,type:'question',groupId:group.id,topic:group.topic,topicIds:group.topicIds,
    title:group.id==='linear'?'矩阵乘法，究竟改变了什么？':`${group.name}，你想从哪个问题开始？`,
    body:group.id==='linear'?'从几何变换的角度，想想矩阵乘法对向量和空间的影响。':'分享一个正在思考的问题，或者说说你希望一起探索的方向。',
  };
}
/** Only the established demo thread is pinned; a new group starts without a topic. */
export function pinnedGroupDiscussion(group:StudyGroup):DiscussionPost|undefined {
  return group.id==='linear'?groupQuestion(group):undefined;
}
export const discussionPosts: DiscussionPost[] = [
  {id:'linear',author:'he',title:'线性代数，我终于找到了一条能走通的路线',body:'从向量的直觉开始，再看矩阵怎样改变空间。这份路线里整理了图解、练习和我的理解，分享给同样在入门的你。',resourceId:'linear'},
  {id:'matrix',author:'lin',title:'矩阵乘法，也可以从图形开始理解',body:'先看基向量怎样变化，再回来看运算顺序。',resourceId:'matrix'},
  {id:'question-gradient',type:'question',topicIds:['machine-learning'],author:'boat',title:'为什么学习率变大，梯度下降反而不收敛？',body:'我画出了几次迭代的位置，但还没理解来回震荡的原因。有没有直观一点的解释？'},
  {id:'group-matrix',author:'he',title:'把旋转和拉伸画出来之后，矩阵终于不只是数字了。',body:'用几何的方式看矩阵变换，向量在变换后的样子一下子就清楚了。',resourceId:'matrix',groupId:'linear'},
  {id:'group-order',author:'lin',title:'我卡在矩阵相乘的顺序，想听听大家怎么理解。',body:'先做 A 再做 B，和先做 B 再做 A，结果为什么不一样？',groupId:'linear'},
  {id:'seed-gradient',author:'me',title:'终于能用自己的话解释梯度下降了',body:'把它想成一步步找下坡的方向，比只记公式更容易理解。我把自己的理解整理成了一页笔记，欢迎一起讨论。',resourceId:'gradient'},
  {id:'seed-summary',author:'me',title:'本周的线性代数学习小结',body:'试着从几何变化的角度，重新理解矩阵。',groupId:'linear'},
];
export const sampleComments: CommunityComment[] = [
  {id:'linear-c1',threadId:'linear',author:'lin',body:'把矩阵理解成空间变换，一下就清楚了。'},
  {id:'linear-r1',threadId:'linear',author:'he',body:'可以先画出两个基向量，再观察变换后的方向。',parentId:'linear-c1',replyToId:'linear-c1'},
  {id:'matrix-c1',threadId:'matrix',author:'boat',body:'沿着基向量的变化去看，比直接背公式直观很多。'},
  {id:'gradient-c1',threadId:'question-gradient',author:'lin',body:'可以把它想成下山时的步幅：步子太大，就可能越过谷底，在两边来回跳。先减小学习率，观察每次更新的位置是否逐渐靠近最低点。'},
  {id:'gradient-r1',threadId:'question-gradient',author:'boat',body:'明白了，原来是每一步跨得太远。我试着把学习率调小。',parentId:'gradient-c1',replyToId:'gradient-c1'},
  {id:'group-c1',threadId:'group-order',author:'he',body:'可以用旋转与拉伸的先后顺序画一遍，对比两张图。'},
];
export function findDiscussion(state:DemoState,id:string):DiscussionPost|undefined {
  if(state.deletedPostIds.includes(id))return undefined;
  const own=state.posts.find(p=>p.id===id);
  if(own)return {id:own.id,author:'me',title:own.title,body:own.body,bodyFormat:own.bodyFormat,type:own.type,topic:own.topic,topicIds:own.topicIds,resourceId:own.resourceId,groupId:own.scope==='仅共学群可见'?(own.groupId||'linear'):undefined};
  const fixture=discussionPosts.find(p=>p.id===id);
  if(fixture)return fixture;
  const group=allGroups(state).find(g=>groupQuestion(g).id===id&&(g.id==='linear'||state.comments.some(comment=>comment.threadId===id)||!!state.commentDrafts[id]?.body));
  if(group)return groupQuestion(group);
  const resource=allResources(state).find(r=>r.id===id);
  return resource?{id,author:resource.author,title:resource.title,body:resource.summary,resourceId:resource.id,groupId:resource.scope==='仅共学群可见'?resource.groupId:undefined}:undefined;
}
export function canReadDiscussion(state:DemoState,post:DiscussionPost) {
  return !post.groupId || state.joinedGroupIds.includes(post.groupId);
}
export function commentsFor(state:DemoState,threadId:string):CommunityComment[] {
  const comments=[...sampleComments,...state.comments].filter(c=>c.threadId===threadId);
  const roots=new Set(comments.filter(c=>!c.parentId).map(c=>c.id));
  return comments.map(c=>c.parentId&&!roots.has(c.parentId)?{...c,parentId:undefined,replyToId:undefined}:c);
}
