import katex from 'katex';
import 'katex/dist/katex.min.css';

export default function ResourceMath({value,display}:{value:string;display:boolean}) {
  const html=katex.renderToString(value,{displayMode:display,throwOnError:false,trust:false,maxExpand:100,maxSize:20,strict:'ignore'});
  return <span className="resource-math" dangerouslySetInnerHTML={{__html:html}}/>;
}
