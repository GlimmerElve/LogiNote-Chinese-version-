import {AccessService,uuid} from './access.js';
import type {Database,Sql} from './db.js';
import {object,onlyKeys,requireValue,text} from './errors.js';
import type {GroupService} from './groups.js';
import {systemClock,type Actor,type Clock} from './types.js';

// Work-item lifecycle follows Plane: optional dates, scoped editors, reversible states,
// version conflict checks and an activity journal. Learning progress is voluntary per member.
export class GroupTaskService {
  constructor(readonly db:Database,readonly access:AccessService,readonly groups:GroupService,readonly clock:Clock=systemClock){}
  private select(){return `SELECT t.object_id AS id,t.group_id AS "groupId",t.title,t.body,t.due_on::text AS "dueOn",t.closed,t.created_at AS "createdAt",t.updated_at AS "updatedAt",o.state,o.version,o.owner_id AS "creatorId",o.restricted_until,a.display_name AS "creatorName",COALESCE(p.state,'none') AS "myState",COALESCE(p.version,0) AS "progressVersion",p.completed_at AS "completedAt",(SELECT count(*)::int FROM group_task_progress q JOIN group_memberships m ON m.group_id=t.group_id AND m.account_id=q.account_id AND m.state='active' WHERE q.task_id=t.object_id AND q.state<>'none') AS "participantCount",(SELECT count(*)::int FROM group_task_progress q JOIN group_memberships m ON m.group_id=t.group_id AND m.account_id=q.account_id AND m.state='active' WHERE q.task_id=t.object_id AND q.state='done') AS "completedCount" FROM group_tasks t JOIN protected_objects o ON o.id=t.object_id JOIN accounts a ON a.id=o.owner_id LEFT JOIN group_task_progress p ON p.task_id=t.object_id AND p.account_id=$1`;}
  private visible(row:any){return row.state==='visible'||row.state==='restricted'&&row.restricted_until&&new Date(row.restricted_until)<=this.clock();}
  private dto(row:any){const {restricted_until,...item}=row;return {...item,state:row.state==='withdrawn'?'removed':row.closed?'closed':'open'};}
  private async row(actor:Actor,id:string,task:string,sql:Sql){const row=(await sql.query(this.select()+' WHERE t.group_id=$2 AND t.object_id=$3',[actor.accountId,id,uuid(task,'任务')])).rows[0];requireValue(row,404,'not_found','没有找到本群的任务。');return row;}
  private async event(actor:Actor,task:string,action:string,sql:Sql){await sql.query('INSERT INTO group_task_events(task_id,actor_id,action,created_at) VALUES($1,$2,$3,$4)',[task,actor.accountId,action,this.clock()]);}
  private fields(input:Record<string,unknown>){
    const title=text(input.title,'任务',160),body=input.body??'',dueOn=input.dueOn??null;
    requireValue(!/[\u0000-\u001f\u007f]/.test(title)&&typeof body==='string'&&body.length<=8000&&!body.includes('\0'),400,'invalid_request','任务内容不正确。');
    requireValue(dueOn===null||typeof dueOn==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(dueOn)&&dueOn>='2000-01-01'&&dueOn<='2100-12-31'&&Number.isFinite(new Date(dueOn).getTime())&&new Date(dueOn).toISOString().slice(0,10)===dueOn,400,'invalid_request','请选择有效的截止日期。');
    return {title,body,dueOn};
  }
  async list(actor:Actor,id:string,input:{view?:string;offset?:string}={}){
    const {member}=await this.groups.learningContext(actor,id,this.db),view=input.view||'open',offset=Number(input.offset||0);
    requireValue(['open','closed','removed'].includes(view)&&Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,400,'invalid_request','任务筛选不正确。');requireValue(view!=='removed'||member.role!=='member',403,'forbidden','需要本群管理权限。');
    const condition=view==='removed'?"o.state='withdrawn'":`(o.state='visible' OR o.state='restricted' AND o.restricted_until<=$4) AND t.closed=${view==='closed'?'true':'false'}`;
    const rows=(await this.db.query(this.select()+` WHERE t.group_id=$2 AND ${condition} ORDER BY t.created_at DESC,t.object_id DESC LIMIT 21 OFFSET $3`,view==='removed'?[actor.accountId,id,offset]:[actor.accountId,id,offset,this.clock()])).rows;
    return {items:rows.slice(0,20).map(row=>this.dto(row)),nextOffset:rows.length>20?offset+20:null};
  }
  async get(actor:Actor,id:string,task:string,sql:Sql=this.db){const {member}=await this.groups.learningContext(actor,id,sql),row=await this.row(actor,id,task,sql);requireValue(this.visible(row)||row.state==='withdrawn'&&member.role!=='member',403,'forbidden','这个任务当前不可见。');return this.dto(row);}
  async create(actor:Actor,id:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['title','body','dueOn']);await this.groups.learningContext(actor,id,sql,true,true);const fields=this.fields(input);
    requireValue(Number((await sql.query("SELECT count(*)::int AS n FROM group_tasks t JOIN protected_objects o ON o.id=t.object_id WHERE t.group_id=$1 AND NOT t.closed AND o.state<>'withdrawn'",[id])).rows[0].n)<100,409,'task_limit','请先结束部分任务；每群最多同时进行一百项任务。');
    const item=await this.access.createObject(actor,{scope:'group',groupId:id},sql);await sql.query('INSERT INTO group_tasks(object_id,group_id,title,body,due_on,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[item.id,id,fields.title,fields.body,fields.dueOn,this.clock()]);await this.event(actor,item.id,'create',sql);return this.get(actor,id,item.id,sql);
  }
  async update(actor:Actor,id:string,task:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['action','expectedVersion','title','body','dueOn']);requireValue(['edit','close','reopen','remove','restore'].includes(String(input.action)),400,'invalid_request','任务操作不正确。');await this.groups.learningContext(actor,id,sql,true,true);const row=await this.row(actor,id,task,sql);
    requireValue(Number.isInteger(input.expectedVersion)&&input.expectedVersion===row.version,409,'version_conflict','任务已更新，请重新读取后操作。');requireValue(input.action==='restore'?row.state==='withdrawn':this.visible(row),403,'forbidden','这个任务当前不可修改。');
    if(input.action==='reopen'||input.action==='restore'&&!row.closed)requireValue(Number((await sql.query("SELECT count(*)::int AS n FROM group_tasks t JOIN protected_objects o ON o.id=t.object_id WHERE t.group_id=$1 AND t.object_id<>$2 AND NOT t.closed AND o.state<>'withdrawn'",[id,task])).rows[0].n)<100,409,'task_limit','请先结束部分任务；每群最多同时进行一百项任务。');
    if(input.action==='edit'){const fields=this.fields(input);await sql.query('UPDATE group_tasks SET title=$2,body=$3,due_on=$4 WHERE object_id=$1',[task,fields.title,fields.body,fields.dueOn]);}
    if(input.action==='close'||input.action==='reopen')await sql.query('UPDATE group_tasks SET closed=$2 WHERE object_id=$1',[task,input.action==='close']);
    await sql.query('UPDATE protected_objects SET state=$2,version=version+1 WHERE id=$1',[task,input.action==='remove'?'withdrawn':'visible']);await sql.query('UPDATE group_tasks SET updated_at=$2 WHERE object_id=$1',[task,this.clock()]);await this.event(actor,task,String(input.action),sql);return this.get(actor,id,task,sql);
  }
  async progress(actor:Actor,id:string,task:string,value:unknown,sql:Sql){
    const input=object(value);onlyKeys(input,['state','expectedVersion']);requireValue(['none','doing','done'].includes(String(input.state)),400,'invalid_request','参与状态不正确。');const {member}=await this.groups.learningContext(actor,id,sql,true),row=await this.row(actor,id,task,sql);
    requireValue(!member.learning_paused,409,'learning_paused','你已暂停共学，可以恢复后继续。');requireValue(this.visible(row)&&!row.closed,403,'task_closed','任务已结束或不可见。');requireValue(Number.isInteger(input.expectedVersion)&&input.expectedVersion===row.progressVersion,409,'version_conflict','你的参与状态已更新，请重新读取。');
    await sql.query('INSERT INTO group_task_progress(task_id,account_id,state,version,completed_at,updated_at) VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(task_id,account_id) DO UPDATE SET state=EXCLUDED.state,version=group_task_progress.version+1,completed_at=EXCLUDED.completed_at,updated_at=EXCLUDED.updated_at',[task,actor.accountId,input.state,input.state==='done'?(row.myState==='done'?row.completedAt:this.clock()):null,this.clock()]);
    await this.event(actor,task,input.state==='done'?'complete':input.state==='doing'?'participate':'withdraw',sql);return this.get(actor,id,task,sql);
  }
  async activity(actor:Actor,id:string,task:string,input:{before?:string}={}){await this.get(actor,id,task);requireValue(input.before===undefined||/^\d{1,18}$/.test(input.before),400,'invalid_request','活动分页不正确。');const rows=(await this.db.query('SELECT e.id::text,e.action,e.created_at AS "createdAt",a.display_name AS "actorName" FROM group_task_events e JOIN accounts a ON a.id=e.actor_id WHERE task_id=$1 AND ($2::bigint IS NULL OR e.id<$2) ORDER BY e.id DESC LIMIT 11',[task,input.before||null])).rows;return {items:rows.slice(0,10),nextBefore:rows.length>10?rows[9].id:null};}
}
