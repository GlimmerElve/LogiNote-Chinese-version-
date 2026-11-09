/** Keep animation frames and loop controls, discard author/location metadata. */
export function stripAnimationMetadata(input:Uint8Array,type:'image/gif'|'image/webp'):Uint8Array {
  const fail=()=>{throw Error('动画图片格式不完整，请换一张图片。');};
  const text=(start:number,end:number)=>String.fromCharCode(...input.subarray(start,end));
  const parts:Uint8Array[]=[];
  if(type==='image/webp'){
    if(input.length<12||text(0,4)!=='RIFF'||text(8,12)!=='WEBP')return fail();
    const view=new DataView(input.buffer,input.byteOffset,input.byteLength);
    if(view.getUint32(4,true)+8!==input.length)return fail();
    parts.push(input.slice(0,12));
    for(let offset=12;offset<input.length;){
      if(offset+8>input.length)return fail();
      const kind=text(offset,offset+4),length=view.getUint32(offset+4,true),end=offset+8+length+(length%2);
      if(end>input.length)return fail();
      if(['VP8X','VP8 ','VP8L','ALPH','ANIM','ANMF'].includes(kind)){
        const chunk=input.slice(offset,end);
        if(kind==='VP8X'){if(length!==10)return fail();chunk[8]&=~0x2c;}
        parts.push(chunk);
      }
      offset=end;
    }
    const result=join(parts);new DataView(result.buffer).setUint32(4,result.length-8,true);return result;
  }
  if(input.length<14||!['GIF87a','GIF89a'].includes(text(0,6)))return fail();
  let offset=13+((input[10]&128)?3*(1<<((input[10]&7)+1)):0);
  if(offset>input.length)return fail();parts.push(input.slice(0,offset));
  const subBlocks=(start:number)=>{let end=start;for(;;){if(end>=input.length)return fail();const length=input[end++];if(!length)return end;end+=length;if(end>input.length)return fail();}};
  while(offset<input.length){
    const start=offset,marker=input[offset++];
    if(marker===0x3b){parts.push(input.slice(start,offset));if(offset!==input.length)return fail();return join(parts);}
    if(marker===0x2c){
      if(offset+9>input.length)return fail();const packed=input[offset+8];offset+=9;
      if(packed&128)offset+=3*(1<<((packed&7)+1));
      if(offset>=input.length)return fail();offset=subBlocks(offset+1);parts.push(input.slice(start,offset));
    }else if(marker===0x21){
      if(offset>=input.length)return fail();const label=input[offset++],dataStart=offset;offset=subBlocks(offset);
      const loop=label===0xff&&input[dataStart]===11&&['NETSCAPE2.0','ANIMEXTS1.0'].includes(text(dataStart+1,dataStart+12));
      if(label===0xf9||loop)parts.push(input.slice(start,offset));
    }else return fail();
  }
  return fail();
}
function join(parts:Uint8Array[]){const result=new Uint8Array(parts.reduce((n,part)=>n+part.length,0));let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;}
