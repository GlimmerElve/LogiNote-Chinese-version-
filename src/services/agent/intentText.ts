/** Routing projection only; the original request still reaches the model unchanged. */
export function agentActionIntentText(text: string): string {
  return text.replace(
    /(?:不要|别|不用|无需|不必|不想|不打算|不需要|暂不|勿)\s*(?:再|先|立即|现在|帮我)?\s*(?:生成|制定|创建|新建|修改|调整|删除|推荐|搜索|查找|下载|上传|提供|导入|复习|温习|简测|定向检测|定向测试|保存|执行|继续|进入|搭建|重排|改动|改变)[^，,。！？?!；;\n]*?(?=[，,。！？?!；;\n]|(?:只(?:帮我|需要|要)?|而是|但是|不过|转而)|$)/gu,
    ' ',
  ).trim();
}
