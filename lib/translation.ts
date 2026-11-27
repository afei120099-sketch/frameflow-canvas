export type TranslationDirection = 'zh-en' | 'en-zh';
export function translationChunks(text: string, maxBytes = 450): string[] {
  const chunks: string[] = [];let chunk='';
  for(const char of text){if(new TextEncoder().encode(chunk+char).length>maxBytes){chunks.push(chunk);chunk='';}chunk+=char;}
  if(chunk)chunks.push(chunk);return chunks;
}
export async function translateText(text: string, direction: TranslationDirection, options: { signal?:AbortSignal; fetch?:typeof fetch } = {}): Promise<string> {
  if(direction!=='zh-en'&&direction!=='en-zh')throw Error('翻译方向无效');
  if(!text.trim())throw Error('请先输入要翻译的文字');
  if(new TextEncoder().encode(text).length>5000)throw Error('单次请控制在5000字节以内（中文约1600字）');
  const output:string[]=[];
  for(const chunk of translationChunks(text)){
    const query=new URLSearchParams({q:chunk,langpair:direction==='zh-en'?'zh-CN|en':'en|zh-CN',mt:'1'});
    const response=await (options.fetch??fetch)(`https://api.mymemory.translated.net/get?${query}`,{signal:options.signal??AbortSignal.timeout(20000),referrerPolicy:'no-referrer'});
    if(!response.ok)throw Error('在线翻译服务暂时不可用，请稍后再试');
    const data=await response.json() as {quotaFinished?:boolean;responseStatus?:number|string;responseData?:{translatedText?:unknown}};
    if(data.quotaFinished||Number(data.responseStatus)!==200)throw Error('翻译服务额度不足或请求被拒绝，请稍后再试');
    const translated=data.responseData?.translatedText;
    if(typeof translated!=='string'||!translated.trim())throw Error('翻译服务没有返回有效译文');
    output.push(translated);
  }
  return output.join('');
}
