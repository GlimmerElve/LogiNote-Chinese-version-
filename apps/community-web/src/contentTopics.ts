import { allGroups, allResources, type DemoState } from './model';
import { legacyTopicIds, normalizeTopicName, validTopicIds } from './topicCatalog';
import { resourcePlainText } from './resourceText';

export type TopicContent={topicIds?:string[];topic?:string;resourceId?:string;groupId?:string};
export function canonicalTopicId(state:DemoState,id:string):string{
  const seen=new Set<string>();let current=id;
  while(Object.hasOwn(state.topicRedirects,current)&&!seen.has(current)){seen.add(current);current=state.topicRedirects[current];}
  return current;
}
export function allContentTopics(state:DemoState){return state.topicCatalog.filter(topic=>canonicalTopicId(state,topic.id)===topic.id);}
export function cleanTopicIds(state:DemoState,ids:string[]){return validTopicIds(ids.map(id=>canonicalTopicId(state,id)),state.topicCatalog);}
export function topicIdsFor(state:DemoState,content:TopicContent):string[]{
  if(Array.isArray(content.topicIds))return cleanTopicIds(state,content.topicIds);
  const legacy=legacyTopicIds(content.topic,state.topicCatalog);
  if(legacy.length)return cleanTopicIds(state,legacy);
  const resource=allResources(state).find(r=>r.id===content.resourceId);
  if(resource)return topicIdsFor(state,resource);
  const group=allGroups(state).find(g=>g.id===content.groupId);
  return group?topicIdsFor(state,group):[];
}
export function topicNamesFor(state:DemoState,content:TopicContent){return topicIdsFor(state,content).map(id=>state.topicCatalog.find(t=>t.id===id)!.name);}
export function findTopic(state:DemoState,query:string){
  const name=normalizeTopicName(query);
  const match=state.topicCatalog.find(topic=>[topic.name,...topic.aliases].some(alias=>normalizeTopicName(alias)===name));
  return match?state.topicCatalog.find(topic=>topic.id===canonicalTopicId(state,match.id)):undefined;
}
export function searchTopics(state:DemoState,query:string){
  const name=normalizeTopicName(query);
  return allContentTopics(state).filter(topic=>!name||state.topicCatalog.some(t=>canonicalTopicId(state,t.id)===topic.id&&[t.name,...t.aliases].some(alias=>normalizeTopicName(alias).includes(name))));
}
export function topicSearchText(state:DemoState,content:TopicContent){
  const ids=topicIdsFor(state,content);
  return state.topicCatalog.filter(t=>ids.includes(canonicalTopicId(state,t.id))).flatMap(t=>[t.name,...t.aliases]).join(' ');
}
// Local suggestions are offered only after opening the optional picker.
export function suggestedTopicIds(text:string):string[]{
  const plain=resourcePlainText(text);
  return [
    /矩阵|向量|线性代数|特征值/.test(plain)?'linear-algebra':'',
    /机器学习|神经网络|梯度下降|学习率|\bML\b/i.test(plain)?'machine-learning':'',
    /论文|共读/.test(plain)?'paper-reading':'',
    /阅读|读书|复述/.test(plain)?'reading-methods':'',
    /写作|表达/.test(plain)?'writing':'',
    /概率|统计/.test(plain)?'probability':'',
  ].filter(Boolean).slice(0,3);
}
