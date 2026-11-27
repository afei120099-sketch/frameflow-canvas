type StateHealth={project:string;state:'healthy'|'corrupt_or_unreadable';checkedAt:string;error?:string};
const projects=new Map<string,StateHealth>();
export function noteInboxStateHealth(project:string,error?:unknown){projects.set(project,{project,state:error?'corrupt_or_unreadable':'healthy',checkedAt:new Date().toISOString(),...(error?{error:String(error)}:{})});}
export function inboxStateHealth(){return [...projects.values()];}
