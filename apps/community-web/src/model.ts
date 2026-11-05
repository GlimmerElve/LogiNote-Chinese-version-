import { initialTopicCatalog, legacyTopicIds, normalizeTopicName, validTopicIds, type ContentTopic } from './topicCatalog';
import type { CommunityAttentionPreferences } from '../../../packages/community-contracts/src/index';
import { MESSAGE_IMAGE_LIMIT, validMessageImageData } from './messageMedia';
export const topics = ['人工智能', '数学', '阅读与写作'] as const;
export type Topic = string;
export type Page = 'home' | 'following' | 'groups' | 'market' | 'discussion' | 'group' | 'friends' | 'me' | 'messages' | 'publish' | 'news' | 'admin' | 'resource' | 'topic' | 'search' | 'account' | 'feedback';
export const pages: Page[] = ['home', 'following', 'groups', 'market', 'discussion', 'group', 'friends', 'me', 'messages', 'publish', 'news', 'admin', 'resource', 'topic', 'search', 'account', 'feedback'];
export type Person = 'me' | 'he' | 'lin' | 'boat';
export type Resource = {
    id: string;
    title: string;
    summary: string;
    author: Person;
    kind: string;
    level: string;
    topic?: Topic;
    topicIds?: string[];
    art: 'space' | 'matrix' | 'code' | 'gradient';
    body?: string;
    bodyFormat?: 'markdown';
    imageIds?: string[];
    cover?: string;
    coverName?: string;
    scope?: '公开' | '仅共学群可见';
    groupId?: string;
    attachmentName?: string;
    license?: string;
    source?: string;
};
export type ResourceImage = {id:string;name:string;data:string};
export type MessageImage = {id:string;name:string;data:string};
export type MessageDraft = {body:string;imageIds:string[]};
export const resources: Resource[] = [
    { id: 'linear', topicIds:['linear-algebra'], title: '线性代数入门路线', summary: '从向量直觉到矩阵变换，按自己的节奏学习。', author: 'he', kind: '学习路线', level: '入门', topic: '数学', art: 'space' },
    { id: 'matrix', topicIds:['linear-algebra'], title: '矩阵乘法的几何解释', summary: '用图解理解矩阵怎样改变空间。', author: 'lin', kind: '知识笔记', level: '入门', topic: '数学', art: 'matrix' },
    { id: 'regression', topicIds:['machine-learning','linear-algebra'], title: '用 Python 练习线性回归', summary: '从一个小例子开始，把概念变成可以运行的代码。', author: 'boat', kind: '练习', level: '基础', topic: '数学', art: 'code' },
    { id: 'gradient', topicIds:['machine-learning'], title: '梯度下降的直觉笔记', summary: '从直觉出发，梳理梯度下降的核心思想、几何图像和简单示例。', author: 'me', kind: '知识笔记', level: '入门', topic: '人工智能', art: 'gradient' },
    ...Array.from({ length: 6 }, (_, i): Resource => ({ id: `more-${i}`, topicIds:['linear-algebra'], title: ['向量空间的几个直观例子', '用图形理解特征向量', '线性代数的小练习', '矩阵变换与坐标系', '从几何理解线性方程组', '一次把概念讲清楚的练习'][i], summary: '沿着已有理解，再向前走一小步。', author: 'he', kind: i % 2 ? '练习' : '知识笔记', level: '入门', topic: '数学', art: i % 2 ? 'matrix' : 'space' })),
    { id: 'reading', topicIds:['reading-methods'], title: '读完一章，怎样留下自己的理解', summary: '用简短的提问和复述，整理一次阅读。', author: 'he', kind: '学习经验', level: '入门', topic: '阅读与写作', art: 'gradient' },
];
export type DemoPost = {
    id: string;
    title?: string;
    body: string;
    bodyFormat?: 'markdown';
    type: 'discovery' | 'question';
    scope: '公开' | '仅共学群可见';
    resourceId?: string;
    groupId?: string;
    topic?: string;
    topicIds?: string[];
};
export type CommunityComment = {
    id: string;
    threadId: string;
    author: Person;
    body: string;
    parentId?: string;
    replyToId?: string;
};
export type CommentDraft = { body: string; replyToId?: string };
export type GroupDraftDetails = {title:string;resourceId:string;topicIds:string[]};
export type Ticket = {
    id: string;
    target: string;
    body: string;
    extra?: string;
    attachmentName?: string;
    status: '待处理' | '已反馈';
    response?: string;
    action?: string;
};
export type Profile = {
    name: string;
    bio: string;
    interests: string[];
    avatar?: string;
};
export type Privacy = {
    intro: '公开' | '仅学友' | '仅自己';
    goal: '公开' | '仅学友' | '仅自己';
};
export type PublicFeedView={query:string;topicId:string;kind:'全部'|'求助'|'资源分享'|'分享发现';limit:number};
export type DemoState = {
    publicFeedView: PublicFeedView;
    followedPeople: Person[];
    blockedPeople: Person[];
    hiddenConversations: string[];
    userResources: Resource[];
    resourceImages: ResourceImage[];
    createdGroups: StudyGroup[];
    joinedGroupIds: string[];
    pendingGroupIds: string[];
    groupCheckins: string[];
    structuredMessages: SharedMessage[];
    messageImages: MessageImage[];
    messageDrafts: Record<string, MessageDraft>;
    publishCover: string;
    publishCoverName: string;
    publishGroupId: string;
    profile: Profile;
    privacy: Privacy;
    attention: CommunityAttentionPreferences;
    bookmarks: string[];
    learning: string[];
    checkedIn: boolean;
    joined: boolean;
    friendRequested: boolean;
    posts: DemoPost[];
    deletedPostIds: string[];
    replies: string[];
    comments: CommunityComment[];
    commentDrafts: Record<string, CommentDraft>;
    messages: Record<string, string[]>;
    tickets: Ticket[];
    questionDraft: string;
    questionTopicIds: string[];
    topicCatalog: ContentTopic[];
    topicRedirects: Record<string,string>;
    groupDraft: string;
    groupDrafts: Record<string,string>;
    groupDraftDetails: Record<string,GroupDraftDetails>;
    feedbackDraft: string;
    feedbackExtraDraft: string;
    publishDraft: string;
    greetingDraft: string;
    publishTitle: string;
    publishTopicIds: string[];
    publishScope: string;
    publishAttachment: string;
    publishSource: string;
    publishLicense: string;
    followedTopics: string[];
    theme: 'light' | 'dark';
};
export const initialState: DemoState = {
    publicFeedView:{query:'',topicId:'',kind:'全部',limit:3},
    followedPeople: [], blockedPeople: [], hiddenConversations: [], userResources: [], resourceImages: [], createdGroups: [], joinedGroupIds: ['linear'], pendingGroupIds: [], groupCheckins: [], structuredMessages: [], messageImages: [], messageDrafts: {},
    publishCover: '', publishCoverName: '', publishGroupId: 'linear',
    profile: { name: '小川', bio: '一边学习，一边把理解慢慢写下来。', interests: [...topics] },
    privacy: { intro: '公开', goal: '仅自己' },
    attention: { ordinaryAlertsEnabled: false, systemPushEnabled: false, soundEnabled: false, vibrationEnabled: false, showUnreadBadges: false, replayAfterFocus: false },
    bookmarks: [], learning: [], checkedIn: false, joined: true, friendRequested: false,
    posts: [], deletedPostIds: [], replies: [], comments: [], commentDrafts: {}, messages: {}, tickets: [], questionDraft: '', groupDraft: '', groupDrafts:{}, groupDraftDetails:{}, feedbackDraft: '', feedbackExtraDraft: '',
    publishTitle: '', publishScope: '资源市场 · 公开', publishAttachment: '', publishSource: '原创内容', publishLicense: '',
    publishDraft: '', greetingDraft: '', questionTopicIds: [], publishTopicIds: [], topicCatalog: initialTopicCatalog, topicRedirects: {},
    followedTopics: [...topics], theme: 'light',
};
export const STORAGE_KEY = 'loginote.community.prototype.v1';
export function readDemo(): DemoState {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (!raw || typeof raw !== 'object')
            return structuredClone(initialState);
        // Only accept our own versioned prototype shape, never desktop identity/vault storage.
        const v = raw as DemoState;
        if (!v.profile || !v.privacy || !v.attention)
            return structuredClone(initialState);
        const next = structuredClone(initialState);
        const strings = ['questionDraft', 'groupDraft', 'feedbackDraft', 'feedbackExtraDraft', 'publishDraft', 'greetingDraft', 'publishTitle', 'publishScope', 'publishAttachment', 'publishSource', 'publishLicense', 'publishCover', 'publishCoverName', 'publishGroupId'] as const;
        for (const key of strings)
            if (typeof v[key] === 'string')
                next[key] = v[key];
        const catalog:ContentTopic[]=[];const ids=new Set<string>(),labels=new Set<string>();
        if(Array.isArray(v.topicCatalog))for(const entry of v.topicCatalog){
            if(!entry||typeof entry.id!=='string'||!/^[-a-zA-Z0-9]+$/.test(entry.id)||ids.has(entry.id)||typeof entry.name!=='string'||!entry.name.trim()||entry.name.length>20||labels.has(normalizeTopicName(entry.name)))continue;
            ids.add(entry.id);labels.add(normalizeTopicName(entry.name));
            catalog.push({id:entry.id,name:entry.name.trim(),aliases:Array.isArray(entry.aliases)?entry.aliases.filter((a):a is string=>typeof a==='string'&&a.length<=30).slice(0,30):[],description:typeof entry.description==='string'?entry.description.slice(0,300):'',directions:Array.isArray(entry.directions)?entry.directions.filter((d):d is string=>typeof d==='string'&&topics.some(t=>t===d)):[]});
        }
        next.topicCatalog=[...catalog,...initialTopicCatalog.filter(t=>!ids.has(t.id)&&!labels.has(normalizeTopicName(t.name)))];
        next.topicRedirects={};
        if(v.topicRedirects&&typeof v.topicRedirects==='object')for(const [from,to] of Object.entries(v.topicRedirects)){
            if(typeof to!=='string'||from===to||!next.topicCatalog.some(t=>t.id===from)||!next.topicCatalog.some(t=>t.id===to))continue;
            let cursor=to;const seen=new Set([from]);while(Object.hasOwn(v.topicRedirects,cursor)&&!seen.has(cursor)){seen.add(cursor);cursor=v.topicRedirects[cursor];}
            if(!seen.has(cursor))Object.defineProperty(next.topicRedirects,from,{value:to,enumerable:true,writable:true,configurable:true});
        }
        const legacy=v as unknown as Record<string,unknown>;
        next.questionTopicIds=Array.isArray(v.questionTopicIds)?validTopicIds(v.questionTopicIds,next.topicCatalog):legacyTopicIds(legacy.questionTopic,next.topicCatalog);
        next.publishTopicIds=Array.isArray(v.publishTopicIds)?validTopicIds(v.publishTopicIds,next.topicCatalog):legacyTopicIds(legacy.publishTopic,next.topicCatalog);
        if(v.publicFeedView&&typeof v.publicFeedView==='object'){
            const view=v.publicFeedView;
            next.publicFeedView={query:typeof view.query==='string'?view.query.slice(0,160):'',topicId:next.topicCatalog.some(topic=>topic.id===view.topicId)?view.topicId:'',kind:['全部','求助','资源分享','分享发现'].includes(view.kind)?view.kind:'全部',limit:Number.isInteger(view.limit)&&view.limit>=3&&view.limit<=300?view.limit:3};
        }
        for (const key of ['name', 'bio'] as const)
            if (typeof v.profile[key] === 'string')
                next.profile[key] = v.profile[key];
        if (validCover(v.profile.avatar)) next.profile.avatar = v.profile.avatar;
        if (Array.isArray(v.profile.interests)) next.profile.interests = [...new Set(v.profile.interests.filter((t): t is string => typeof t === 'string' && !!t.trim()).map(t=>t.trim().slice(0,20)))].slice(0,8);
        for (const key of ['intro', 'goal'] as const) {
            const allowed = ['公开', '仅学友', '仅自己'];
            if (allowed.includes(v.privacy[key]))
                Object.assign(next.privacy, { [key]: v.privacy[key] });
        }
        const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
        next.bookmarks = stringList(v.bookmarks);
        next.deletedPostIds = stringList(v.deletedPostIds);
        next.learning = stringList(v.learning);
        next.replies = stringList(v.replies);
        const seenCommentIds = new Set<string>();
        next.comments = Array.isArray(v.comments) ? v.comments.filter(c => {
            if(!c || typeof c.id!=='string' || !c.id || seenCommentIds.has(c.id) || typeof c.threadId!=='string' || !c.threadId || !['me','he','lin','boat'].includes(c.author) || typeof c.body!=='string' || !c.body.trim())return false;
            seenCommentIds.add(c.id); return true;
        }).map(c=>({id:c.id,threadId:c.threadId,author:c.author,body:c.body,parentId:typeof c.parentId==='string'?c.parentId:undefined,replyToId:typeof c.replyToId==='string'?c.replyToId:undefined})) : [];
        // The old form belonged to the gradient question but had no thread key.
        // Migrate once; never display these replies beneath other posts.
        if(!Array.isArray(v.comments))next.comments=next.replies.map((body,index)=>({id:`legacy-comment-${index}`,threadId:'question-gradient',author:'me',body}));
        next.commentDrafts={};
        if(v.commentDrafts&&typeof v.commentDrafts==='object')for(const [id,draft] of Object.entries(v.commentDrafts)){
            if(draft&&typeof draft.body==='string')Object.defineProperty(next.commentDrafts,id,{value:{body:draft.body,replyToId:typeof draft.replyToId==='string'?draft.replyToId:undefined},enumerable:true,writable:true,configurable:true});
        }
        next.followedTopics = stringList(v.followedTopics).filter(x => topics.some(t => t === x));
        if (!Array.isArray(v.followedTopics))
            next.followedTopics = [...topics];
        next.posts = Array.isArray(v.posts) ? v.posts.filter(p => p && typeof p.id === 'string' && typeof p.body === 'string' && ['discovery', 'question'].includes(p.type) && ['公开', '仅共学群可见'].includes(p.scope)).map(p => ({ ...p, resourceId: typeof p.resourceId === 'string' ? p.resourceId : undefined })) : [];
        next.posts = next.posts.filter(p=>!next.deletedPostIds.includes(p.id));
        next.posts = next.posts.map(p=>({...p,title:typeof p.title==='string'?p.title.slice(0,160):undefined,bodyFormat:p.bodyFormat==='markdown'?'markdown':undefined,topic:typeof p.topic==='string'?p.topic:undefined,topicIds:Array.isArray(p.topicIds)?validTopicIds(p.topicIds,next.topicCatalog):undefined}));
        next.tickets = Array.isArray(v.tickets) ? v.tickets.filter(t => t && typeof t.id === 'string' && typeof t.target === 'string' && typeof t.body === 'string' && ['待处理', '已反馈'].includes(t.status)).map(t => ({ ...t, response: typeof t.response === 'string' ? t.response : undefined, extra: typeof t.extra === 'string' ? t.extra : undefined, attachmentName: typeof t.attachmentName === 'string' ? t.attachmentName : undefined })) : [];
        next.messages = {};
        if (v.messages && typeof v.messages === 'object')
            for (const key of ['lin', 'he', 'boat', 'group'])
                next.messages[key] = stringList(v.messages[key]);
        for (const key of ['checkedIn', 'joined', 'friendRequested'] as const)
            if (typeof v[key] === 'boolean')
                next[key] = v[key];
        next.theme = v.theme === 'dark' ? 'dark' : 'light';
        next.attention = { ...initialState.attention, ordinaryAlertsEnabled: v.attention.ordinaryAlertsEnabled === true };
        next.blockedPeople=stringList(v.blockedPeople).filter((person):person is Person=>['he','lin','boat'].includes(person));
        next.hiddenConversations=stringList(v.hiddenConversations).filter(person=>['he','lin','boat'].includes(person));
        next.followedPeople = stringList(v.followedPeople).filter((p): p is Person => ['he','lin','boat'].includes(p));
        next.userResources = Array.isArray(v.userResources) ? v.userResources.filter(isResource).map(r=>({...r, cover:validCover(r.cover)?r.cover:undefined, body:typeof r.body==='string'?r.body:'', coverName:typeof r.coverName==='string'?r.coverName:undefined, attachmentName:typeof r.attachmentName==='string'?r.attachmentName:undefined, license:typeof r.license==='string'?r.license:undefined, source:typeof r.source==='string'?r.source:undefined, groupId:typeof r.groupId==='string'?r.groupId:undefined})) : [];
        next.userResources=next.userResources.map(r=>({...r,topicIds:Array.isArray(r.topicIds)?validTopicIds(r.topicIds,next.topicCatalog):undefined,bodyFormat:r.bodyFormat==='markdown'?'markdown':undefined,imageIds:stringList(r.imageIds).filter(id=>/^image-[a-zA-Z0-9-]+$/.test(id))}));
        const seenImages=new Set<string>();
        next.resourceImages=Array.isArray(v.resourceImages)?v.resourceImages.filter(image=>{
            if(!image||typeof image.id!=='string'||!/^image-[a-zA-Z0-9-]+$/.test(image.id)||seenImages.has(image.id)||typeof image.name!=='string'||!validCover(image.data))return false;
            seenImages.add(image.id);return true;
        }).map(image=>({id:image.id,name:image.name.slice(0,160),data:image.data})):[];
        const usedImages=new Set([next.publishDraft,...next.userResources.map(r=>r.body||'')].flatMap(imageReferences));
        next.resourceImages=next.resourceImages.filter(image=>usedImages.has(image.id));
        next.createdGroups = Array.isArray(v.createdGroups) ? v.createdGroups.filter(isGroup).map(g=>({...g,topicIds:Array.isArray(g.topicIds)?validTopicIds(g.topicIds,next.topicCatalog):undefined})) : [];
        next.groupDrafts={};
        if(v.groupDrafts&&typeof v.groupDrafts==='object')for(const [id,body] of Object.entries(v.groupDrafts)){if(typeof body==='string'&&allGroups(next).some(g=>g.id===id))Object.defineProperty(next.groupDrafts,id,{value:body,enumerable:true,writable:true,configurable:true});}
        else if(next.groupDraft)next.groupDrafts.linear=next.groupDraft;
        next.groupDraftDetails = {};
        if(v.groupDraftDetails && typeof v.groupDraftDetails === 'object' && !Array.isArray(v.groupDraftDetails))for(const [id,details] of Object.entries(v.groupDraftDetails)){
            if(!allGroups(next).some(group=>group.id===id) || !details || typeof details !== 'object' || Array.isArray(details))continue;
            Object.defineProperty(next.groupDraftDetails,id,{value:{
                title:typeof details.title==='string'?details.title.slice(0,160):'',
                resourceId:typeof details.resourceId==='string'?details.resourceId.slice(0,200):'',
                topicIds:validTopicIds(details.topicIds,next.topicCatalog),
            },enumerable:true,writable:true,configurable:true});
        }
        next.joinedGroupIds = Array.isArray(v.joinedGroupIds)?stringList(v.joinedGroupIds):(v.joined===false?[]:['linear']);
        next.pendingGroupIds = stringList(v.pendingGroupIds);
        next.groupCheckins = Array.isArray(v.groupCheckins)?stringList(v.groupCheckins):(v.checkedIn?['linear']:[]);
        const seenMessageImages = new Set<string>();
        next.messageImages = Array.isArray(v.messageImages) ? v.messageImages.filter(image => {
            if(!image || typeof image.id !== 'string' || !/^chat-image-[a-zA-Z0-9-]+$/.test(image.id) || seenMessageImages.has(image.id) || typeof image.name !== 'string' || !validMessageImageData(image.data))return false;
            seenMessageImages.add(image.id);return true;
        }).map(image=>({id:image.id,name:image.name.slice(0,160),data:image.data})) : [];
        const messageImageIds = (value: unknown) => [...new Set(stringList(value).filter(id=>seenMessageImages.has(id)))].slice(0,MESSAGE_IMAGE_LIMIT);
        next.structuredMessages = Array.isArray(v.structuredMessages) ? v.structuredMessages.filter(isMessage).map(message=>{
            const imageIds = messageImageIds(message.imageIds);
            const missingImageOnly = Array.isArray(message.imageIds) && message.imageIds.length > 0 && !imageIds.length && !message.body.trim() && !message.resourceId && !message.groupId;
            return {
                id:message.id,conversation:message.conversation,body:missingImageOnly?'图片无法显示（本地图片已失效）':message.body,
                ...(typeof message.resourceId==='string'?{resourceId:message.resourceId}:{}),
                ...(typeof message.groupId==='string'?{groupId:message.groupId}:{}),
                ...(messageTopicBelongsToGroup(next,message.conversation,message.topicId)?{topicId:message.topicId}:{}),
                ...(Array.isArray(message.imageIds)?{imageIds}:{}),
            };
        }) : Object.entries(next.messages).flatMap(([conversation,texts])=>texts.map((body,index)=>({id:`legacy-${conversation}-${index}`,conversation:conversation==='group'?'group:linear':conversation,body})));
        next.messageDrafts = {};
        if(v.messageDrafts && typeof v.messageDrafts === 'object' && !Array.isArray(v.messageDrafts))for(const [conversation,draft] of Object.entries(v.messageDrafts)){
            if(!draft || typeof draft !== 'object' || Array.isArray(draft) || typeof draft.body !== 'string')continue;
            Object.defineProperty(next.messageDrafts,conversation,{value:{body:draft.body,imageIds:messageImageIds(draft.imageIds)},enumerable:true,writable:true,configurable:true});
        }
        const usedMessageImages = new Set([
            ...next.structuredMessages.flatMap(message=>message.imageIds || []),
            ...Object.values(next.messageDrafts).flatMap(draft=>draft.imageIds),
        ]);
        next.messageImages = next.messageImages.filter(image=>usedMessageImages.has(image.id));
        if(!validCover(next.publishCover))next.publishCover='';
        // Remove only the exact untouched legacy example; preserve all authored drafts.
        if(!Array.isArray(v.userResources)&&next.publishTitle==='矩阵乘法的几何解释'&&next.publishDraft==='用图解理解矩阵怎样改变空间。这是我整理的几个直观例子，希望能帮到同样在学习的你。'&&next.publishAttachment==='矩阵图解.pdf'){
            next.publishTitle='';next.publishDraft='';next.publishAttachment='';
        }
        return next;
    }
    catch {
        return structuredClone(initialState);
    }
}
export const names: Record<Person, string> = { me: '小川', he: '晓禾', lin: '林同学', boat: '小舟' };

export type StudyGroup = {id:string; name:string; description:string; topic?:string; topicIds?:string[]; policy:'open'|'request'; creator:Person};
export const studyGroups: StudyGroup[] = [
  {id:'linear',topicIds:['linear-algebra'],name:'线性代数共学',description:'从直觉出发，一起读懂线性代数。',topic:'数学',policy:'open',creator:'he'},
  {id:'ml-reading',topicIds:['machine-learning','paper-reading'],name:'机器学习论文共读',description:'每次读懂一个问题，交换方法与疑问。',topic:'人工智能',policy:'request',creator:'lin'},
  {id:'writing',topicIds:['reading-methods','writing'],name:'慢慢读，慢慢写',description:'分享阅读中的发现，用自己的话留下理解。',topic:'阅读与写作',policy:'open',creator:'boat'},
];
export const people = [
  {id:'he' as Person,name:'晓禾',bio:'用图像理解数学，也在学习如何把问题讲清楚。',goal:'把线性代数讲得更直观',interests:['数学','阅读与写作']},
  {id:'lin' as Person,name:'林同学',bio:'喜欢画图，也喜欢把复杂的问题拆开。',goal:'理解矩阵变换与机器学习',interests:['数学','人工智能']},
  {id:'boat' as Person,name:'小舟',bio:'从一个能运行的小例子开始学习。',goal:'用 Python 理解机器学习',interests:['人工智能','阅读与写作']},
];
export type SharedMessage = {id:string; conversation:string; body:string; resourceId?:string; groupId?:string; topicId?:string; imageIds?:string[]};
export function allResources(state:DemoState){return [...state.userResources,...resources];}
export function allGroups(state:DemoState){return [...state.createdGroups,...studyGroups];}
/** Historical ownership is independent of today's membership and topic visibility. */
export function messageTopicBelongsToGroup(state:DemoState,conversation:string,value:unknown):value is string {
    if(typeof value!=='string'||!value||!conversation.startsWith('group:'))return false;
    const groupId=conversation.slice(6);
    if(!allGroups(state).some(group=>group.id===groupId))return false;
    if(value.startsWith('group-question:')&&value!==`group-question:${groupId}`)return false;
    const own=state.posts.find(post=>post.id===value);
    if(own)return own.scope==='仅共学群可见'&&(own.groupId||'linear')===groupId;
    if(['group-matrix','group-order','seed-summary'].includes(value))return groupId==='linear';
    // Public fixtures take precedence over resources with the same IDs in findDiscussion.
    if(['linear','matrix','question-gradient','seed-gradient'].includes(value))return false;
    // This stable namespace carries its group ownership even after old replies are gone.
    if(value===`group-question:${groupId}`)return true;
    const resource=allResources(state).find(item=>item.id===value);
    return !!resource&&resource.scope==='仅共学群可见'&&resource.groupId===groupId;
}
/** Sending additionally requires a currently readable, undeleted topic. */
export function validMessageTopic(state:DemoState,conversation:string,value:unknown):value is string {
    if(!messageTopicBelongsToGroup(state,conversation,value)||state.deletedPostIds.includes(value))return false;
    const groupId=conversation.slice(6);
    if(!state.joinedGroupIds.includes(groupId))return false;
    if(value===`group-question:${groupId}`&&!state.posts.some(post=>post.id===value))return groupId==='linear'||state.comments.some(comment=>comment.threadId===value)||(Object.hasOwn(state.commentDrafts,value)&&!!state.commentDrafts[value]?.body);
    return true;
}
export function validCover(value:unknown):value is string{return typeof value==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)&&value.length<1_500_000;}
export function imageReferences(body:string):string[]{return [...new Set([...body.matchAll(/!\[[^\]\n]*\]\(attachment:(image-[a-zA-Z0-9-]+)\)/g)].map(match=>match[1]))];}
function isResource(r:unknown):r is Resource {if(!r||typeof r!=='object')return false;const v=r as Resource;return typeof v.id==='string'&&typeof v.title==='string'&&typeof v.summary==='string'&&v.author==='me'&&typeof v.kind==='string'&&typeof v.level==='string'&&(typeof v.topic==='string'||Array.isArray(v.topicIds))&&['space','matrix','code','gradient'].includes(v.art)&&['公开','仅共学群可见'].includes(v.scope||'');}
function isGroup(g:unknown):g is StudyGroup {if(!g||typeof g!=='object')return false;const v=g as StudyGroup;return typeof v.id==='string'&&typeof v.name==='string'&&typeof v.description==='string'&&(typeof v.topic==='string'||Array.isArray(v.topicIds))&&v.creator==='me'&&['open','request'].includes(v.policy);}
function isMessage(m:unknown):m is SharedMessage {if(!m||typeof m!=='object')return false;const v=m as SharedMessage;return typeof v.id==='string'&&typeof v.conversation==='string'&&typeof v.body==='string'&&(v.resourceId===undefined||typeof v.resourceId==='string')&&(v.groupId===undefined||typeof v.groupId==='string');}
