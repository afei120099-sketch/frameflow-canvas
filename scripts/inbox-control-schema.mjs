export function parseFileControls(parsed){
 const result={};
 for(const key of ['pauseSessions','priority','interruptRunning']){const value=parsed[key]??[];if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!id.trim()))throw Error(`${key}必须是sessionId数组`);result[key]=[...new Set(value)];}
 for(const key of ['rerunShots','skipShots']){const value=parsed[key]??[];if(!Array.isArray(value)||value.some(s=>!s||typeof s.sessionId!=='string'||!s.sessionId||!Array.isArray(s.titles)||!s.titles.length||s.titles.some(t=>typeof t!=='string'||!t)||s.cascade!==undefined&&typeof s.cascade!=='boolean'||s.requestId!==undefined&&(typeof s.requestId!=='string'||!s.requestId)))throw Error(`${key}需要sessionId和非空titles数组；cascade为布尔值`);result[key]=value;}
 const maxRetries=parsed.retry?.maxRetries??1;if(!Number.isSafeInteger(maxRetries)||maxRetries<0||maxRetries>10)throw Error('retry.maxRetries必须是0到10的整数');result.retry={maxRetries};
 return result;
}
