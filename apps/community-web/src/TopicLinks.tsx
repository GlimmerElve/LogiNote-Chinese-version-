import { useApp } from './context';
import { topicIdsFor, type TopicContent } from './contentTopics';

export function TopicLinks({content}:{content:TopicContent}){
  const {state,go}=useApp();const ids=topicIdsFor(state,content);
  if(!ids.length)return null;
  return <div className="content-topic-links">{ids.map(id=><button type="button" key={id} onClick={()=>go('topic',id)}>#{state.topicCatalog.find(topic=>topic.id===id)!.name}</button>)}</div>;
}
