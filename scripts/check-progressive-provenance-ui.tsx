import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressiveCourseReader } from '../src/components/progressive/ProgressiveCourseReader';
import { progressiveProvenance } from '../src/services/progressiveLearning/sourcePolicy';
const copyright={id:'S1',kind:'document',title:'教材.pdf',text:'# 版权信息\nISBN:1234567890\n出版社：合成',locator:'PRIVATE_DOC@PRIVATE_VERSION / 版权信息'};
const useful={...copyright,text:'荷马用身体词汇描述经验，词汇现象与心理经验之间需要额外证据。',locator:'PRIVATE_DOC@PRIVATE_VERSION / 青铜时代'};
function markup(source:any,body='本页讲解[S1]。'){
 const page:any={id:'main-1',kind:'mainline',mainlineIndex:0,title:'身体词汇',body,questions:[],sourcePackets:source?[source]:[],hook:{id:'h',kind:'reflection',prompt:'哪些是观察，哪些是解释？'}};
 const course:any={id:'course',plan:{pages:[{id:'main-1',title:page.title,objectives:[]}]},pages:[{id:'main-1',kind:'mainline',mainlineIndex:0,contentHash:'hash'}],page,firstPage:page,sourcePackets:page.sourcePackets,generation:{status:'ready'},progress:{currentPageId:'main-1',scrollTop:0},budget:{totalPageLimit:4}};
 const snapshot:any={phase:'ready',course,page,plan:course.plan,blocks:[body],pendingText:'',isDirty:false};
 return renderToStaticMarkup(<ProgressiveCourseReader snapshot={snapshot} onRetry={()=>{}} onRetrySave={()=>{}} onReadingPosition={()=>{}} readOnly/>);
}
const bad=markup(copyright);assert.ok(bad.includes('data-teaching-provenance="unusable-excerpts"'));assert.ok(bad.includes('不能用于核实教材内容'));assert.ok(!bad.includes('已绑定资料的选取片段'));
const good=markup(useful);assert.ok(good.includes('已提供参考片段：1 段'));assert.ok(good.includes('正文来源标记 1 处'));assert.ok(good.includes('查看参考片段'));assert.ok(good.includes('青铜时代'));assert.ok(!good.includes('PRIVATE_DOC'));assert.ok(!good.includes('PRIVATE_VERSION'));
assert.ok(markup(null,'没有来源标记的讲解。').includes('未提供可用的资料正文片段'));
assert.equal(progressiveProvenance([useful as any],'文中[S1]，又标注[S1]，未知[S2]。').markers,2);
assert.equal(progressiveProvenance([useful as any],'文中[S1]，又标注[S1]，未知[S2]。').invalidMarkers,1);
assert.equal(useful.locator,'PRIVATE_DOC@PRIVATE_VERSION / 青铜时代');
console.log('PASS provided excerpts/markers are separate facts; old copyright-only sources flagged; raw IDs stay hidden; sources and teaching remain unchanged');
