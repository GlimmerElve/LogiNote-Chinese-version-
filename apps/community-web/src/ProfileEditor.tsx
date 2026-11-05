import { useRef, useState } from 'react';
import { useApp } from './context';
import { topics } from './model';
import { prepareProfileAvatar } from './profileAvatarImage';
import { Avatar, LinkButton, Primary } from './ui';

export function EditProfile() {
  const { state, patch, setNotice, notice } = useApp();
  const [profile, setProfile] = useState(state.profile);
  const [interest, setInterest] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const selection = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const addInterest = () => {
    const tag = interest.trim();
    if (!tag || profile.interests.length >= 8) return;
    setProfile(p => ({...p, interests: [...new Set([...p.interests, tag])]}));
    setInterest('');
  };
  const chooseAvatar = async (file?: File) => {
    if (!file) return;
    const request = ++selection.current;
    setError(''); setLoading(true);
    try {
      const data = await prepareProfileAvatar(file);
      if (request === selection.current) setProfile(p => ({...p, avatar: data}));
    } catch (cause) {
      if (request === selection.current) setError(cause instanceof Error ? cause.message : '图片无法读取，请换一张图片。');
    } finally { if (request === selection.current) setLoading(false); }
  };
  return <form onSubmit={e => {
    e.preventDefault();
    patch({profile: {...profile, name:profile.name.trim()}});
    setNotice('演示：资料已在本机更新。');
  }}>
    <div className="profile-avatar-editor">
      <Avatar size={88} src={profile.avatar || ''}/>
      <div><LinkButton onClick={()=>input.current?.click()}>更换头像</LinkButton>
        {profile.avatar && <LinkButton onClick={()=>{selection.current++;setLoading(false);setError('');setProfile(p=>({...p,avatar:undefined}));}}>恢复默认头像</LinkButton>}
        <p className="meta">PNG、JPG、WebP，原图 10 MB 以内，自动压缩</p></div>
      <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择头像图片" onChange={e=>{void chooseAvatar(e.target.files?.[0]);e.target.value='';}}/>
    </div>
    {loading && <p role="status">正在读取图片…</p>}{error && <p className="inline-status" role="alert">{error}</p>}
    {([['name','昵称'],['bio','一句介绍']] as const).map(([key,label])=><label className="field-label" key={key}>{label}<input required={key==='name'} maxLength={key==='name'?30:160} value={profile[key]} onChange={e=>setProfile({...profile,[key]:e.target.value})}/></label>)}
    <fieldset className="interest-editor"><legend>兴趣标签</legend><div className="topic-picker">{[...new Set([...topics,...profile.interests])].map(tag=><button type="button" className={`chip ${profile.interests.includes(tag)?'active':''}`} aria-pressed={profile.interests.includes(tag)} disabled={!profile.interests.includes(tag)&&profile.interests.length>=8} key={tag} onClick={()=>setProfile({...profile,interests:profile.interests.includes(tag)?profile.interests.filter(t=>t!==tag):[...profile.interests,tag]})}>{tag}</button>)}</div>
      <div className="interest-input"><input aria-label="添加兴趣标签" placeholder="添加自己的兴趣…" maxLength={20} value={interest} onChange={e=>setInterest(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();addInterest();}}}/><LinkButton disabled={!interest.trim()||profile.interests.length>=8} onClick={addInterest}>添加</LinkButton></div>
      <p className="meta">最多 8 个，点击已选标签可取消。</p>
    </fieldset>
    <p className="meta">当前目标后续从 LogiNote 客户端读取，这里无需填写。</p>
    {notice && <p className="inline-status" role="status">{notice}</p>}
    <Primary type="submit" disabled={!profile.name.trim()||loading}>保存资料</Primary>
  </form>;
}
