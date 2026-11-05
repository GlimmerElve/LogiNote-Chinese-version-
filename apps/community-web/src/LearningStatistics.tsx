import {useEffect,useState} from 'react';
import {LEARNING_METRICS,learningMetricLabels,learningMetricUnits,statisticsDate,type DisplayedLearningStatistics,type LearningStatisticsPolicy} from '../../community-api/src/learningStatisticsContract';
import {communityResources,type ConnectedDevice} from './serviceResourceClient';
import {communityGroups,type GroupInfo} from './serviceGroupClient';
import {LinkButton} from './ui';
import './learning-statistics.css';
export const defaultStatisticsPolicy:LearningStatisticsPolicy={enabled:false,metrics:['streak','activeDaysThisMonth'],scope:'public',groupIds:[],sourceDeviceId:null,revision:0};

export function LearningStatistics({value,compact=false}:{value?:DisplayedLearningStatistics|null;compact?:boolean}){
  if(value?.state!=='ready')return null;
  const metrics=LEARNING_METRICS.filter(metric=>typeof value.values[metric]==='number');
  if(!metrics.length)return null;
  const stale=value.asOfDate!==statisticsDate(new Date(),value.timeZone);
  if(compact)return <p className="learning-statistics-compact">{metrics.slice(0,2).map(metric=>`${learningMetricLabels[metric]} ${value.values[metric]} ${learningMetricUnits[metric]}`).join(' · ')}{stale&&<span> · 截至 {value.asOfDate.slice(5).replace('-','/')}</span>}</p>;
  return <div className="learning-statistics" aria-label="学习统计"><dl>{metrics.map(metric=><div key={metric}><dd>{value.values[metric]}<span>{learningMetricUnits[metric]}</span></dd><dt>{learningMetricLabels[metric]}</dt></div>)}</dl>{stale&&<p className="learning-statistics-date">截至 {value.asOfDate.replaceAll('-','/')}</p>}</div>;
}

export function LearningStatisticsEditor({value,onChange,disabled,onConnect}:{value:LearningStatisticsPolicy;onChange:(policy:LearningStatisticsPolicy)=>void;disabled:boolean;onConnect:()=>void}){
  const [devices,setDevices]=useState<ConnectedDevice[]>([]),[groups,setGroups]=useState<GroupInfo[]>([]),[next,setNext]=useState<number|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{const controller=new AbortController();void Promise.all([communityResources.devices(controller.signal),communityGroups.list({view:'mine'},controller.signal)]).then(([connected,result])=>{setDevices(connected);setGroups(result.items);setNext(result.nextOffset);}).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[]);
  const patch=(change:Partial<LearningStatisticsPolicy>)=>onChange({...value,...change});
  return <div className="statistics-editor">
    <label className="statistics-choice"><input type="checkbox" checked={value.enabled} disabled={disabled||loading} onChange={event=>patch({enabled:event.target.checked,sourceDeviceId:value.sourceDeviceId||devices.find(device=>device.isDefault)?.id||devices[0]?.id||null})}/>在个人主页展示学习统计</label>
    {value.enabled&&<>
      <p className="meta">来自 LogiNote 终端，只展示你选中的数字。</p>
      <div className="statistics-metrics">{LEARNING_METRICS.map(metric=><label className="statistics-choice" key={metric}><input type="checkbox" checked={value.metrics.includes(metric)} disabled={disabled||value.metrics.length===1&&value.metrics.includes(metric)} onChange={event=>patch({metrics:event.target.checked?LEARNING_METRICS.filter(item=>item===metric||value.metrics.includes(item)):value.metrics.filter(item=>item!==metric)})}/>{learningMetricLabels[metric]}</label>)}</div>
      {devices.length>0?<label className="field-label">读取终端<select aria-label="学习统计来源" value={value.sourceDeviceId||''} disabled={disabled} onChange={event=>patch({sourceDeviceId:event.target.value})}><option value="" disabled>选择终端</option>{devices.map(device=><option key={device.id} value={device.id}>{device.label}{device.isDefault?'（默认设备）':''}</option>)}</select></label>:<p className="meta">{loading?'正在读取终端…':<>还没有连接终端。<LinkButton onClick={onConnect}>连接 LogiNote</LinkButton></>}</p>}
      <label className="field-label">谁可以看<select aria-label="学习统计展示范围" value={value.scope} disabled={disabled} onChange={event=>patch({scope:event.target.value as 'public'|'groups'})}><option value="public">公开</option><option value="groups">指定共学群的成员</option></select></label>
      {value.scope==='groups'&&<div className="statistics-group-choices">{groups.filter(group=>group.membership==='active').map(group=><label className="statistics-choice" key={group.id}><input type="checkbox" checked={value.groupIds.includes(group.id)} disabled={disabled||!value.groupIds.includes(group.id)&&value.groupIds.length>=10} onChange={event=>patch({groupIds:event.target.checked?[...value.groupIds,group.id]:value.groupIds.filter(id=>id!==group.id)})}/>{group.name}</label>)}{!loading&&!groups.some(group=>group.membership==='active')&&<p className="meta">还没有加入共学群。</p>}{next!==null&&<LinkButton disabled={loading} onClick={()=>{setLoading(true);void communityGroups.list({view:'mine',offset:next}).then(result=>{setGroups(prior=>[...prior,...result.items]);setNext(result.nextOffset);}).catch(cause=>setError(cause.message)).finally(()=>setLoading(false));}}>更多共学群</LinkButton>}</div>}
      <p className="meta">保存后由所选终端同步，返回主页时更新。关闭后将移除展示。</p>
    </>}
    {error&&<p role="alert" className="meta">{error}</p>}
  </div>;
}
