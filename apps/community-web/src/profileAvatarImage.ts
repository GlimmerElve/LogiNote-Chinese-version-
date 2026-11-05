export const MAX_AVATAR_SOURCE_BYTES=10*1024*1024;
/** Accept camera-sized originals, but store only a small metadata-free thumbnail. */
export async function prepareProfileAvatar(file:File):Promise<string>{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>MAX_AVATAR_SOURCE_BYTES)throw new Error('请选择 10 MB 以内的 PNG、JPG 或 WebP 图片。');
  const url=URL.createObjectURL(file),image=new Image();
  try{
    image.src=url;await image.decode();
    if(!image.naturalWidth||!image.naturalHeight)throw new Error();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const context=canvas.getContext('2d');if(!context)throw new Error();
    const edge=Math.min(image.naturalWidth,image.naturalHeight);context.drawImage(image,(image.naturalWidth-edge)/2,(image.naturalHeight-edge)/2,edge,edge,0,0,256,256);
    for(const quality of [.85,.7,.55,.4]){
      const result=canvas.toDataURL('image/webp',quality);
      if(result.startsWith('data:image/webp;base64,')&&result.length<='data:image/webp;base64,'.length+4*Math.ceil(32768/3))return result;
    }
    throw new Error('图片压缩后仍过大，请选择更简洁的头像。');
  }catch(cause){throw new Error(cause instanceof Error&&cause.message.startsWith('图片压缩')?cause.message:'图片无法读取，请换一张 PNG、JPG 或 WebP 图片。');}
  finally{URL.revokeObjectURL(url);}
}
